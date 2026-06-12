import { compressImage } from './compressImage'
import {
  findCatalogRowByHash,
  recordCatalogUpload,
  sha256hex,
  tryDedupExisting,
} from './mediaAssetsCatalog'
import { uploadToNhostStorage } from './nhostStorage'
import type { MediaUploadResult, ParsedUploadFile } from './types'

export async function processMediaUpload(
  file: ParsedUploadFile,
  userId: string,
  options?: { compress?: boolean },
): Promise<MediaUploadResult> {
  const originalByteLength = file.buffer.byteLength
  const compressed = await compressImage(file.buffer, file.mimetype, file.filename, options)
  const hash = sha256hex(compressed.buffer)

  const existingRow = await findCatalogRowByHash(hash)

  const deduped = await tryDedupExisting(hash)
  if (deduped) {
    return {
      fileUrl: deduped.fileUrl,
      filePath: deduped.filePath,
      mediaUuid: deduped.mediaUuid,
      deduped: true,
      filename: file.filename,
    }
  }

  const { fileId, publicUrl } = await uploadToNhostStorage(
    compressed.buffer,
    compressed.contentType,
    compressed.outputFilename,
  )

  const mediaUuid = await recordCatalogUpload({
    existingUuid: existingRow?.id ?? null,
    storageFileId: fileId,
    publicUrl,
    sha256: hash,
    fileSize: originalByteLength,
    contentType: compressed.contentType,
    originalName: file.filename,
    uploadedBy: userId,
  })

  return {
    fileUrl: publicUrl,
    filePath: `storage/${fileId}`,
    mediaUuid,
    deduped: false,
    filename: file.filename,
  }
}

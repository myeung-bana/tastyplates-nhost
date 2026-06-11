import { compressImage } from './compressImage'
import { isS3Backend } from './config'
import {
  findCatalogRowByHash,
  recordCatalogUpload,
  sha256hex,
  tryDedupExisting,
} from './mediaAssetsCatalog'
import { uploadToNhostStorage } from './nhostStorage'
import { uploadToS3 } from './s3Storage'
import type { MediaUploadResult, ParsedUploadFile } from './types'

export async function processMediaUpload(
  file: ParsedUploadFile,
  userId: string,
  options?: { compress?: boolean },
): Promise<MediaUploadResult> {
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

  if (isS3Backend()) {
    const s3 = await uploadToS3(userId, compressed.buffer, compressed.contentType, compressed.extension)
    const mediaUuid = await recordCatalogUpload({
      existingUuid: existingRow?.uuid ?? null,
      storageFileId: null,
      publicUrl: s3.fileUrl,
      sha256: hash,
      fileSize: compressed.buffer.byteLength,
      contentType: compressed.contentType,
      originalName: file.filename,
      uploadedBy: userId,
      s3Key: s3.s3Key,
      s3Bucket: s3.s3Bucket,
    })

    return {
      fileUrl: s3.fileUrl,
      filePath: s3.filePath,
      mediaUuid,
      deduped: false,
      filename: file.filename,
    }
  }

  const { fileId, publicUrl } = await uploadToNhostStorage(
    compressed.buffer,
    compressed.contentType,
    compressed.outputFilename,
  )

  const mediaUuid = await recordCatalogUpload({
    existingUuid: existingRow?.uuid ?? null,
    storageFileId: fileId,
    publicUrl,
    sha256: hash,
    fileSize: compressed.buffer.byteLength,
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

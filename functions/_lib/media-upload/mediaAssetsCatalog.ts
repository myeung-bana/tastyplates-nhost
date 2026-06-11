import { createHash } from 'node:crypto'

import { hasuraAdmin } from '../hasura'
import { isS3Backend } from './config'
import { nhostStorageFileExists } from './nhostStorage'

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

type CatalogRow = {
  uuid: string
  public_url: string
  storage_file_id: string | null
}

const DEDUP_QUERY = `
  query DedupCheck($sha256: String!) {
    media_assets(where: { sha256: { _eq: $sha256 } }, limit: 1) {
      uuid
      public_url
      storage_file_id
    }
  }
`

const INSERT_ASSET = `
  mutation InsertMediaAsset(
    $storageFileId: uuid
    $publicUrl: String!
    $sha256: String
    $fileSize: bigint
    $contentType: String
    $originalName: String
    $uploadedBy: uuid!
    $s3Key: String
    $s3Bucket: String
  ) {
    insert_media_assets_one(object: {
      storage_file_id: $storageFileId
      public_url: $publicUrl
      sha256: $sha256
      file_size: $fileSize
      content_type: $contentType
      original_name: $originalName
      uploaded_by: $uploadedBy
      s3_key: $s3Key
      s3_bucket: $s3Bucket
    }) {
      uuid
      public_url
    }
  }
`

const UPDATE_ASSET = `
  mutation UpdateMediaAsset(
    $uuid: uuid!
    $storageFileId: uuid
    $publicUrl: String!
    $sha256: String
    $fileSize: bigint
    $contentType: String
    $s3Key: String
    $s3Bucket: String
  ) {
    update_media_assets(
      where: { uuid: { _eq: $uuid } }
      _set: {
        storage_file_id: $storageFileId
        public_url: $publicUrl
        sha256: $sha256
        file_size: $fileSize
        content_type: $contentType
        s3_key: $s3Key
        s3_bucket: $s3Bucket
      }
    ) {
      returning { uuid public_url }
    }
  }
`

export async function findCatalogRowByHash(hash: string): Promise<CatalogRow | null> {
  try {
    const data = await hasuraAdmin<{ media_assets: CatalogRow[] }>(DEDUP_QUERY, { sha256: hash })
    return data.media_assets?.[0] ?? null
  } catch {
    return null
  }
}

async function insertCatalogRow(params: {
  storageFileId: string | null
  publicUrl: string
  sha256: string
  fileSize: number
  contentType: string
  originalName: string
  uploadedBy: string
  s3Key?: string | null
  s3Bucket?: string | null
}): Promise<string | null> {
  try {
    const data = await hasuraAdmin<{
      insert_media_assets_one: { uuid: string } | null
    }>(INSERT_ASSET, {
      storageFileId: params.storageFileId,
      publicUrl: params.publicUrl,
      sha256: params.sha256,
      fileSize: params.fileSize,
      contentType: params.contentType,
      originalName: params.originalName,
      uploadedBy: params.uploadedBy,
      s3Key: params.s3Key ?? null,
      s3Bucket: params.s3Bucket ?? null,
    })
    return data.insert_media_assets_one?.uuid ?? null
  } catch (e) {
    console.warn('[media-upload] catalog insert skipped:', e)
    return null
  }
}

async function updateCatalogRow(
  uuid: string,
  params: {
    storageFileId: string | null
    publicUrl: string
    sha256: string
    fileSize: number
    contentType: string
    s3Key?: string | null
    s3Bucket?: string | null
  },
): Promise<void> {
  try {
    await hasuraAdmin(UPDATE_ASSET, {
      uuid,
      storageFileId: params.storageFileId,
      publicUrl: params.publicUrl,
      sha256: params.sha256,
      fileSize: params.fileSize,
      contentType: params.contentType,
      s3Key: params.s3Key ?? null,
      s3Bucket: params.s3Bucket ?? null,
    })
  } catch (e) {
    console.warn('[media-upload] catalog update skipped:', e)
  }
}

/** Returns existing URL when dedup hits; null when caller should upload. */
export async function tryDedupExisting(
  hash: string,
): Promise<{ fileUrl: string; filePath: string; mediaUuid: string; deduped: true } | null> {
  if (isS3Backend()) return null

  const existing = await findCatalogRowByHash(hash)
  if (!existing) return null

  if (existing.storage_file_id) {
    const ok = await nhostStorageFileExists(existing.storage_file_id)
    if (ok) {
      return {
        fileUrl: existing.public_url,
        filePath: `storage/${existing.storage_file_id}`,
        mediaUuid: existing.uuid,
        deduped: true,
      }
    }
  } else if (existing.public_url) {
    return {
      fileUrl: existing.public_url,
      filePath: existing.public_url,
      mediaUuid: existing.uuid,
      deduped: true,
    }
  }

  return null
}

export async function recordCatalogUpload(params: {
  existingUuid?: string | null
  storageFileId: string | null
  publicUrl: string
  sha256: string
  fileSize: number
  contentType: string
  originalName: string
  uploadedBy: string
  s3Key?: string | null
  s3Bucket?: string | null
}): Promise<string | null> {
  if (params.existingUuid) {
    await updateCatalogRow(params.existingUuid, {
      storageFileId: params.storageFileId,
      publicUrl: params.publicUrl,
      sha256: params.sha256,
      fileSize: params.fileSize,
      contentType: params.contentType,
      s3Key: params.s3Key,
      s3Bucket: params.s3Bucket,
    })
    return params.existingUuid
  }

  return insertCatalogRow(params)
}

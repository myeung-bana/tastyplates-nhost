import { createHash } from 'node:crypto'

import { hasuraAdmin } from '../hasura'
import { STORAGE_BUCKET } from './config'
import { nhostStorageFileExists } from './nhostStorage'

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Production `media_assets` matches the legacy Tastyplates schema:
 * - PK is `id` (uuid), not a separate `uuid` column
 * - Nhost Storage file id is stored in `s3_key`; bucket id in `s3_bucket`
 * - `size_bytes`, `original_filename`, `uploaded_by_user_id`
 */
type CatalogRow = {
  id: string
  public_url: string
  s3_key: string | null
  s3_bucket: string | null
}

const DEDUP_QUERY = `
  query DedupCheck($sha256: String!) {
    media_assets(
      where: { sha256: { _eq: $sha256 }, deleted_at: { _is_null: true } }
      limit: 1
    ) {
      id
      public_url
      s3_key
      s3_bucket
    }
  }
`

const INSERT_ASSET = `
  mutation InsertMediaAsset(
    $s3Key: String!
    $s3Bucket: String!
    $publicUrl: String!
    $sha256: String!
    $sizeBytes: bigint!
    $contentType: String!
    $originalFilename: String
    $uploadedByUserId: uuid!
  ) {
    insert_media_assets_one(object: {
      s3_key: $s3Key
      s3_bucket: $s3Bucket
      public_url: $publicUrl
      sha256: $sha256
      size_bytes: $sizeBytes
      content_type: $contentType
      original_filename: $originalFilename
      uploaded_by_user_id: $uploadedByUserId
    }) {
      id
      public_url
    }
  }
`

const UPDATE_ASSET = `
  mutation UpdateMediaAsset(
    $id: uuid!
    $s3Key: String!
    $s3Bucket: String!
    $publicUrl: String!
    $sha256: String!
    $sizeBytes: bigint!
    $contentType: String!
  ) {
    update_media_assets(
      where: { id: { _eq: $id } }
      _set: {
        s3_key: $s3Key
        s3_bucket: $s3Bucket
        public_url: $publicUrl
        sha256: $sha256
        size_bytes: $sizeBytes
        content_type: $contentType
      }
    ) {
      returning { id public_url }
    }
  }
`

function isNhostBackedRow(row: CatalogRow): boolean {
  return Boolean(row.s3_key && row.s3_bucket === STORAGE_BUCKET)
}

export async function findCatalogRowByHash(hash: string): Promise<CatalogRow | null> {
  const data = await hasuraAdmin<{ media_assets: CatalogRow[] }>(DEDUP_QUERY, { sha256: hash })
  return data.media_assets?.[0] ?? null
}

async function insertCatalogRow(params: {
  storageFileId: string
  publicUrl: string
  sha256: string
  fileSize: number
  contentType: string
  originalName: string
  uploadedBy: string
}): Promise<string> {
  const data = await hasuraAdmin<{
    insert_media_assets_one: { id: string } | null
  }>(INSERT_ASSET, {
    s3Key: params.storageFileId,
    s3Bucket: STORAGE_BUCKET,
    publicUrl: params.publicUrl,
    sha256: params.sha256,
    sizeBytes: params.fileSize,
    contentType: params.contentType,
    originalFilename: params.originalName,
    uploadedByUserId: params.uploadedBy,
  })

  const id = data.insert_media_assets_one?.id
  if (!id) {
    throw new Error('Failed to save media catalog entry')
  }
  return id
}

async function updateCatalogRow(
  id: string,
  params: {
    storageFileId: string
    publicUrl: string
    sha256: string
    fileSize: number
    contentType: string
  },
): Promise<void> {
  const data = await hasuraAdmin<{
    update_media_assets: { returning: Array<{ id: string }> }
  }>(UPDATE_ASSET, {
    id,
    s3Key: params.storageFileId,
    s3Bucket: STORAGE_BUCKET,
    publicUrl: params.publicUrl,
    sha256: params.sha256,
    sizeBytes: params.fileSize,
    contentType: params.contentType,
  })

  if (!data.update_media_assets?.returning?.length) {
    throw new Error('Failed to update media catalog entry')
  }
}

/**
 * Returns existing Nhost Storage URL when dedup hits.
 * Legacy S3 rows (different bucket) fall through so caller re-uploads to Nhost.
 */
export async function tryDedupExisting(
  hash: string,
): Promise<{ fileUrl: string; filePath: string; mediaUuid: string; deduped: true } | null> {
  const existing = await findCatalogRowByHash(hash)
  if (!existing || !isNhostBackedRow(existing)) return null

  const exists = await nhostStorageFileExists(existing.s3_key!)
  if (!exists) return null

  return {
    fileUrl: existing.public_url,
    filePath: `storage/${existing.s3_key}`,
    mediaUuid: existing.id,
    deduped: true,
  }
}

export async function recordCatalogUpload(params: {
  existingUuid?: string | null
  storageFileId: string
  publicUrl: string
  sha256: string
  fileSize: number
  contentType: string
  originalName: string
  uploadedBy: string
}): Promise<string> {
  if (params.existingUuid) {
    await updateCatalogRow(params.existingUuid, {
      storageFileId: params.storageFileId,
      publicUrl: params.publicUrl,
      sha256: params.sha256,
      fileSize: params.fileSize,
      contentType: params.contentType,
    })
    return params.existingUuid
  }

  return insertCatalogRow(params)
}

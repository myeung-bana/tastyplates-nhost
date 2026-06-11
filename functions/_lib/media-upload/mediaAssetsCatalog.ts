import { createHash } from 'node:crypto'

import { hasuraAdmin } from '../hasura'
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
    $storageFileId: uuid!
    $publicUrl: String!
    $sha256: String
    $fileSize: bigint
    $contentType: String
    $originalName: String
    $uploadedBy: uuid!
  ) {
    insert_media_assets_one(object: {
      storage_file_id: $storageFileId
      public_url: $publicUrl
      sha256: $sha256
      file_size: $fileSize
      content_type: $contentType
      original_name: $originalName
      uploaded_by: $uploadedBy
    }) {
      uuid
      public_url
    }
  }
`

const UPDATE_ASSET = `
  mutation UpdateMediaAsset(
    $uuid: uuid!
    $storageFileId: uuid!
    $publicUrl: String!
    $sha256: String
    $fileSize: bigint
    $contentType: String
  ) {
    update_media_assets(
      where: { uuid: { _eq: $uuid } }
      _set: {
        storage_file_id: $storageFileId
        public_url: $publicUrl
        sha256: $sha256
        file_size: $fileSize
        content_type: $contentType
        s3_key: null
        s3_bucket: null
      }
    ) {
      returning { uuid public_url }
    }
  }
`

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
    insert_media_assets_one: { uuid: string } | null
  }>(INSERT_ASSET, {
    storageFileId: params.storageFileId,
    publicUrl: params.publicUrl,
    sha256: params.sha256,
    fileSize: params.fileSize,
    contentType: params.contentType,
    originalName: params.originalName,
    uploadedBy: params.uploadedBy,
  })

  const uuid = data.insert_media_assets_one?.uuid
  if (!uuid) {
    throw new Error('Failed to save media catalog entry')
  }
  return uuid
}

async function updateCatalogRow(
  uuid: string,
  params: {
    storageFileId: string
    publicUrl: string
    sha256: string
    fileSize: number
    contentType: string
  },
): Promise<void> {
  const data = await hasuraAdmin<{
    update_media_assets: { returning: Array<{ uuid: string }> }
  }>(UPDATE_ASSET, {
    uuid,
    storageFileId: params.storageFileId,
    publicUrl: params.publicUrl,
    sha256: params.sha256,
    fileSize: params.fileSize,
    contentType: params.contentType,
  })

  if (!data.update_media_assets?.returning?.length) {
    throw new Error('Failed to update media catalog entry')
  }
}

/**
 * Returns existing Nhost Storage URL when dedup hits.
 * Legacy rows without storage_file_id fall through so caller re-uploads to Nhost.
 */
export async function tryDedupExisting(
  hash: string,
): Promise<{ fileUrl: string; filePath: string; mediaUuid: string; deduped: true } | null> {
  const existing = await findCatalogRowByHash(hash)
  if (!existing?.storage_file_id) return null

  const exists = await nhostStorageFileExists(existing.storage_file_id)
  if (!exists) return null

  return {
    fileUrl: existing.public_url,
    filePath: `storage/${existing.storage_file_id}`,
    mediaUuid: existing.uuid,
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

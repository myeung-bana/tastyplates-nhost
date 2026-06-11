import { STORAGE_BUCKET, storageAdminSecret, storageBaseUrl } from './config'

function buildMultipartBody(
  fileBytes: Buffer,
  contentType: string,
  filename: string,
  bucketId: string,
): { body: Buffer; boundary: string } {
  const boundary = `----TastyPlatesBoundary${Date.now().toString(16)}`
  const CRLF = '\r\n'

  const preamble = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="bucket-id"${CRLF}${CRLF}` +
      `${bucketId}${CRLF}` +
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
      `Content-Type: ${contentType}${CRLF}${CRLF}`,
    'utf-8',
  )
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf-8')
  return { body: Buffer.concat([preamble, fileBytes, epilogue]), boundary }
}

export async function uploadToNhostStorage(
  fileBytes: Buffer,
  contentType: string,
  filename: string,
): Promise<{ fileId: string; publicUrl: string }> {
  const { body, boundary } = buildMultipartBody(fileBytes, contentType, filename, STORAGE_BUCKET)
  const url = `${storageBaseUrl()}/v1/files`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.byteLength),
      'x-hasura-admin-secret': storageAdminSecret(),
    },
    body: new Uint8Array(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Storage upload failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const json = (await res.json()) as { id?: string }
  const fileId = json.id
  if (!fileId) throw new Error('Storage returned no file ID')

  return {
    fileId,
    publicUrl: `${storageBaseUrl()}/v1/files/${fileId}`,
  }
}

export async function nhostStorageFileExists(fileId: string): Promise<boolean> {
  const res = await fetch(`${storageBaseUrl()}/v1/files/${fileId}/presignedurl`, {
    headers: { 'x-hasura-admin-secret': storageAdminSecret() },
  })
  return res.ok
}

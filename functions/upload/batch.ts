import type { Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import Busboy from 'busboy'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { requireAuth, getUserId } from '../_lib/auth'
import { ok, fail } from '../_lib/respond'

const MAX_FILES = 10

function getS3Client() {
  return new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  })
}

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/avif': '.avif', 'video/mp4': '.mp4',
  }
  return map[mimeType] ?? '.bin'
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)
    const bucketName = process.env.S3_BUCKET_NAME!
    const bucketDomain = process.env.S3_BUCKET_DOMAIN ?? `https://${bucketName}.s3.amazonaws.com`

    const files = await new Promise<Array<{ buffer: Buffer; mimetype: string; filename: string }>>((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers })
      const collected: Array<{ buffer: Buffer; mimetype: string; filename: string }> = []
      let count = 0

      busboy.on('file', (_fieldname, stream, info) => {
        if (count >= MAX_FILES) {
          stream.resume()
          return
        }
        count++
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => collected.push({ buffer: Buffer.concat(chunks), mimetype: info.mimeType, filename: info.filename }))
        stream.on('error', reject)
      })

      busboy.on('error', reject)
      busboy.on('finish', () => resolve(collected))
      req.pipe(busboy)
    })

    if (files.length === 0) return fail(res, 'No files received', 400)

    const s3 = getS3Client()
    const userPrefix = `uploads/${userId}`

    const results = await Promise.allSettled(
      files.map(async (file) => {
        const fileId = randomBytes(16).toString('hex')
        const ext = extFromMime(file.mimetype)
        const filePath = `${userPrefix}/${fileId}${ext}`

        await s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: filePath,
          Body: file.buffer,
          ContentType: file.mimetype,
        }))

        const fileUrl = `${bucketDomain}/${filePath}`
        return { fileUrl, filePath, filename: file.filename }
      }),
    )

    const successful = results
      .filter((r): r is PromiseFulfilledResult<{ fileUrl: string; filePath: string; filename: string }> => r.status === 'fulfilled')
      .map(r => r.value)

    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => ({ error: String(r.reason) }))

    ok(res, { files: successful, errors: failed })
  } catch (error) {
    console.error('[upload/batch]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import Busboy from 'busboy'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { requireAuth, getUserId } from '../_lib/auth'
import { ok, fail } from '../_lib/respond'

function getS3Client() {
  return new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  })
}

function getExt(mimetype: string): string {
  if (mimetype === 'image/avif') return '.avif'
  if (mimetype === 'image/webp') return '.webp'
  if (mimetype === 'image/jpeg') return '.jpg'
  if (mimetype === 'image/png') return '.png'
  return '.bin'
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    const maxWidth = parseInt(process.env.IMAGE_MAX_WIDTH ?? '1600')
    const maxHeight = parseInt(process.env.IMAGE_MAX_HEIGHT ?? '1600')
    const avifQuality = parseInt(process.env.IMAGE_AVIF_QUALITY ?? '60')
    const webpQuality = parseInt(process.env.IMAGE_WEBP_QUALITY ?? '75')
    const bucketName = process.env.S3_BUCKET_NAME!
    const bucketDomain = process.env.S3_BUCKET_DOMAIN ?? `https://${bucketName}.s3.amazonaws.com`

    const fileBuffer = await new Promise<{ buffer: Buffer; mimetype: string; filename: string }>((resolve, reject) => {
      const busboy = Busboy({ headers: req.headers })
      let resolved = false

      busboy.on('file', (_fieldname, stream, info) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          if (!resolved) {
            resolved = true
            resolve({ buffer: Buffer.concat(chunks), mimetype: info.mimeType, filename: info.filename })
          }
        })
        stream.on('error', reject)
      })

      busboy.on('error', reject)
      busboy.on('finish', () => {
        if (!resolved) reject(new Error('No file received'))
      })

      req.pipe(busboy)
    })

    const s3 = getS3Client()
    const fileId = randomBytes(16).toString('hex')
    const userPrefix = `uploads/${userId}`

    let uploadBuffer: Buffer
    let contentType: string
    let ext: string

    try {
      uploadBuffer = await sharp(fileBuffer.buffer)
        .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
        .avif({ quality: avifQuality })
        .toBuffer()
      contentType = 'image/avif'
      ext = '.avif'
    } catch {
      uploadBuffer = await sharp(fileBuffer.buffer)
        .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: webpQuality })
        .toBuffer()
      contentType = 'image/webp'
      ext = '.webp'
    }

    const filePath = `${userPrefix}/${fileId}${ext}`

    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: filePath,
      Body: uploadBuffer,
      ContentType: contentType,
    }))

    const fileUrl = `${bucketDomain}/${filePath}`

    ok(res, { fileUrl, filePath })
  } catch (error) {
    console.error('[upload/image]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

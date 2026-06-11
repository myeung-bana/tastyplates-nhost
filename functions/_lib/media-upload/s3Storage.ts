import { randomBytes } from 'node:crypto'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { s3Config } from './config'

let s3Client: S3Client | null = null

function getClient(): S3Client {
  if (!s3Client) {
    const cfg = s3Config()
    s3Client = new S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    })
  }
  return s3Client
}

export async function uploadToS3(
  userId: string,
  fileBytes: Buffer,
  contentType: string,
  extension: string,
): Promise<{ fileUrl: string; filePath: string; s3Key: string; s3Bucket: string }> {
  const cfg = s3Config()
  const fileId = randomBytes(16).toString('hex')
  const filePath = `uploads/${userId}/${fileId}${extension}`
  const client = getClient()

  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucketName,
      Key: filePath,
      Body: fileBytes,
      ContentType: contentType,
    }),
  )

  return {
    fileUrl: `${cfg.bucketDomain}/${filePath}`,
    filePath,
    s3Key: filePath,
    s3Bucket: cfg.bucketName,
  }
}

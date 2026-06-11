import process from 'node:process'

import { NHOST_ADMIN_SECRET, NHOST_REGION, NHOST_SUBDOMAIN } from '../env'

export const MEDIA_STORAGE_BACKEND = (process.env.MEDIA_STORAGE_BACKEND ?? 'nhost').toLowerCase()

export const STORAGE_BUCKET = process.env.MEDIA_STORAGE_BUCKET ?? 'tasty-bucket'

export const IMAGE_MAX_WIDTH = parseInt(process.env.IMAGE_MAX_WIDTH ?? '1600', 10)
export const IMAGE_MAX_HEIGHT = parseInt(process.env.IMAGE_MAX_HEIGHT ?? '1600', 10)
export const IMAGE_AVIF_QUALITY = parseInt(process.env.IMAGE_AVIF_QUALITY ?? '60', 10)
export const IMAGE_WEBP_QUALITY = parseInt(process.env.IMAGE_WEBP_QUALITY ?? '75', 10)

export const BATCH_MAX_FILES = parseInt(process.env.UPLOAD_BATCH_MAX_FILES ?? '10', 10)

export function storageBaseUrl(): string {
  return `https://${NHOST_SUBDOMAIN}.storage.${NHOST_REGION}.nhost.run`
}

export function storageAdminSecret(): string {
  return NHOST_ADMIN_SECRET
}

export function isS3Backend(): boolean {
  return MEDIA_STORAGE_BACKEND === 's3'
}

export function s3Config(): {
  region: string
  bucketName: string
  bucketDomain: string
  accessKeyId: string
  secretAccessKey: string
} {
  const bucketName = process.env.S3_BUCKET_NAME
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  if (!bucketName || !accessKeyId || !secretAccessKey) {
    throw new Error('S3 upload backend requires S3_BUCKET_NAME, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY')
  }
  return {
    region: process.env.S3_REGION ?? 'us-east-1',
    bucketName,
    bucketDomain: process.env.S3_BUCKET_DOMAIN ?? `https://${bucketName}.s3.amazonaws.com`,
    accessKeyId,
    secretAccessKey,
  }
}

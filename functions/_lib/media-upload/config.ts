import process from 'node:process'

import { NHOST_ADMIN_SECRET, NHOST_REGION, NHOST_SUBDOMAIN } from '../env'

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

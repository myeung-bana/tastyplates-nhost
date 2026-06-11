import sharp from 'sharp'

import {
  IMAGE_AVIF_QUALITY,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_WEBP_QUALITY,
} from './config'

export interface CompressedImage {
  buffer: Buffer
  contentType: string
  extension: string
}

function isImageMime(mimetype: string): boolean {
  return mimetype.startsWith('image/') && mimetype !== 'image/gif'
}

/** Resize + AVIF with WebP fallback. Non-images pass through unchanged. */
export async function compressImage(
  originalBytes: Buffer,
  clientMime: string,
  filename: string,
  options?: { compress?: boolean },
): Promise<CompressedImage & { outputFilename: string }> {
  const shouldCompress = options?.compress !== false && isImageMime(clientMime)

  if (!shouldCompress) {
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.bin'
    return {
      buffer: originalBytes,
      contentType: clientMime || 'application/octet-stream',
      extension: ext,
      outputFilename: filename,
    }
  }

  try {
    const buffer = await sharp(originalBytes)
      .resize(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .avif({ quality: IMAGE_AVIF_QUALITY })
      .toBuffer()
    const base = filename.replace(/\.[^.]+$/, '')
    return {
      buffer,
      contentType: 'image/avif',
      extension: '.avif',
      outputFilename: `${base}.avif`,
    }
  } catch {
    const buffer = await sharp(originalBytes)
      .resize(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_WEBP_QUALITY })
      .toBuffer()
    const base = filename.replace(/\.[^.]+$/, '')
    return {
      buffer,
      contentType: 'image/webp',
      extension: '.webp',
      outputFilename: `${base}.webp`,
    }
  }
}

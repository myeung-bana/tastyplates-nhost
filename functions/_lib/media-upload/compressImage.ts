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

// sharp default export typing varies by module resolution; lazy import avoids Nhost cold-start crashes.
type SharpConstructor = (input: Buffer) => {
  resize: (w: number, h: number, opts: object) => {
    avif: (opts: object) => { toBuffer: () => Promise<Buffer> }
    webp: (opts: object) => { toBuffer: () => Promise<Buffer> }
  }
}

let sharpLoader: Promise<SharpConstructor | null> | null = null

/** Lazy-load sharp so upload handlers can boot on Nhost (esbuild excludes native sharp at import time). */
async function getSharp(): Promise<SharpConstructor | null> {
  if (!sharpLoader) {
    sharpLoader = import('sharp')
      .then((mod) => mod.default)
      .catch((err) => {
        console.warn('[media-upload] sharp unavailable, uploading without compression:', err)
        return null
      })
  }
  return sharpLoader
}

function isImageMime(mimetype: string): boolean {
  return mimetype.startsWith('image/') && mimetype !== 'image/gif'
}

function passthrough(
  originalBytes: Buffer,
  clientMime: string,
  filename: string,
): CompressedImage & { outputFilename: string } {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.bin'
  return {
    buffer: originalBytes,
    contentType: clientMime || 'application/octet-stream',
    extension: ext,
    outputFilename: filename,
  }
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
    return passthrough(originalBytes, clientMime, filename)
  }

  const sharp = await getSharp()
  if (!sharp) {
    return passthrough(originalBytes, clientMime, filename)
  }

  const base = filename.replace(/\.[^.]+$/, '')

  try {
    const buffer = await sharp(originalBytes)
      .resize(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .avif({ quality: IMAGE_AVIF_QUALITY })
      .toBuffer()
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
    return {
      buffer,
      contentType: 'image/webp',
      extension: '.webp',
      outputFilename: `${base}.webp`,
    }
  }
}

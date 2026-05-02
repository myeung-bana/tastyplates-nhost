import type { Request, Response } from 'express';
import sharp from 'sharp';
import { rateLimitOrThrow, uploadRateLimit } from '../_lib/rate-limit';
import { generateFileName, uploadToS3 } from '../_lib/s3';

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

async function processImage(
  buffer: Buffer,
  mimeType: string,
  preferredFormat: 'webp' | 'avif' = 'avif'
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  if (mimeType === 'image/gif') {
    return { buffer, contentType: 'image/gif', extension: 'gif' };
  }

  const maxWidth = parseInt(process.env.IMAGE_MAX_WIDTH || '1600', 10);
  const maxHeight = parseInt(process.env.IMAGE_MAX_HEIGHT || '1600', 10);

  if (preferredFormat === 'avif') {
    try {
      const avifQuality = parseInt(process.env.IMAGE_AVIF_QUALITY || '60', 10);
      const processed = await sharp(buffer)
        .rotate()
        .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
        .avif({ quality: avifQuality, effort: 4 })
        .toBuffer();
      return { buffer: processed, contentType: 'image/avif', extension: 'avif' };
    } catch {
      // Fall through to WebP
    }
  }

  const webpQuality = parseInt(process.env.IMAGE_WEBP_QUALITY || '75', 10);
  const processed = await sharp(buffer)
    .rotate()
    .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: webpQuality })
    .toBuffer();
  return { buffer: processed, contentType: 'image/webp', extension: 'webp' };
}

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
    req.headers['x-real-ip'] as string ||
    'unknown';

  const rl = await rateLimitOrThrow(ip, uploadRateLimit);
  if (!rl.ok) {
    res.status(429).set('Retry-After', String(rl.retryAfter)).json({
      success: false,
      error: 'Rate limit exceeded. Please try again later.',
      retryAfter: rl.retryAfter,
    });
    return;
  }

  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.status(400).json({ success: false, error: 'Expected multipart/form-data' });
      return;
    }

    const file = (req as any).file as {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
      size: number;
    } | undefined;

    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }

    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      res.status(400).json({ success: false, error: `Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}` });
      return;
    }

    if (file.size > MAX_SIZE) {
      res.status(400).json({ success: false, error: `File exceeds max size of ${MAX_SIZE / 1024 / 1024}MB` });
      return;
    }

    const { buffer: processedBuffer, contentType: outContentType, extension } = await processImage(
      file.buffer,
      file.mimetype
    );

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const fileName = generateFileName(file.originalname, extension);
    const s3Key = `uploads/${year}/${month}/${fileName}`;

    const fileUrl = await uploadToS3({
      key: s3Key,
      body: processedBuffer,
      contentType: outContentType,
      metadata: {
        originalName: file.originalname,
        originalType: file.mimetype,
        originalSize: String(file.size),
      },
    });

    res.json({ success: true, fileUrl, filePath: s3Key, message: 'File uploaded successfully' });
  } catch (error: any) {
    console.error('[uploads/image] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to upload file' });
  }
};

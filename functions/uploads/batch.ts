import type { Request, Response } from 'express';
import { rateLimitOrThrow, uploadRateLimit } from '../_lib/rate-limit';
import { uploadToS3 } from '../_lib/s3';
import { randomBytes } from 'crypto';

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 10;

function getExtension(mimeType: string, fileName: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  if (map[mimeType]) return map[mimeType];
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'jpg';
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
      error: 'Rate limit exceeded.',
      retryAfter: rl.retryAfter,
    });
    return;
  }

  try {
    const files = (req as any).files as Array<{
      originalname: string;
      mimetype: string;
      buffer: Buffer;
      size: number;
    }> | undefined;

    if (!files || files.length === 0) {
      res.status(400).json({ success: false, error: 'No files provided' });
      return;
    }

    if (files.length > MAX_FILES) {
      res.status(400).json({ success: false, error: `Maximum ${MAX_FILES} files allowed per batch` });
      return;
    }

    const validFiles: typeof files = [];
    const validationErrors: Array<{ fileName: string; error: string }> = [];

    for (const file of files) {
      if (!ALLOWED_TYPES.includes(file.mimetype)) {
        validationErrors.push({ fileName: file.originalname, error: `Invalid type: ${file.mimetype}` });
        continue;
      }
      if (file.size > MAX_SIZE) {
        validationErrors.push({ fileName: file.originalname, error: `File too large: ${file.size} bytes` });
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length === 0) {
      res.status(400).json({ success: false, errors: validationErrors, message: 'All files failed validation' });
      return;
    }

    const uploadResults = await Promise.all(
      validFiles.map(async (file) => {
        try {
          const ext = getExtension(file.mimetype, file.originalname);
          const s3Key = `gallery/${Date.now()}_${randomBytes(8).toString('hex')}.${ext}`;
          const fileUrl = await uploadToS3({
            key: s3Key,
            body: file.buffer,
            contentType: file.mimetype,
            metadata: { originalName: file.originalname, originalSize: String(file.size) },
          });
          return { fileName: file.originalname, fileUrl, filePath: s3Key };
        } catch (err: any) {
          return { fileName: file.originalname, error: err.message || 'Upload failed' };
        }
      })
    );

    const successful = uploadResults.filter((r) => 'fileUrl' in r);
    const failed = uploadResults.filter((r) => 'error' in r) as Array<{ fileName: string; error: string }>;
    const allErrors = [...validationErrors, ...failed];

    if (successful.length === 0) {
      res.status(500).json({ success: false, errors: allErrors, message: 'All uploads failed' });
      return;
    }

    res.json({
      success: true,
      files: successful,
      errors: allErrors.length > 0 ? allErrors : undefined,
      message: `${successful.length} file(s) uploaded successfully${allErrors.length > 0 ? `, ${allErrors.length} failed` : ''}`,
    });
  } catch (error: any) {
    console.error('[uploads/batch] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to upload files' });
  }
};

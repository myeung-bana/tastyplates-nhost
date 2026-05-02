import type { Request, Response } from 'express';
import { rateLimitOrThrow, uploadRateLimit } from '../_lib/rate-limit';

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
    const { photoUrl } = req.body || {};

    if (!photoUrl || typeof photoUrl !== 'string') {
      res.status(400).json({ success: false, error: 'Photo URL is required' });
      return;
    }

    if (!photoUrl.includes('maps.googleapis.com') && !photoUrl.includes('googleapis.com')) {
      res.status(400).json({ success: false, error: 'Only Google Places photo URLs are allowed.' });
      return;
    }

    const response = await fetch(photoUrl, {
      headers: {
        Referer: process.env.NHOST_BACKEND_URL || process.env.APP_URL || 'https://tastyplates.co',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/jpeg';

    res.json({ success: true, data: `data:${mimeType};base64,${base64}` });
  } catch (error: any) {
    console.error('[images/download-google-photo] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download image from Google',
      details: error.message,
    });
  }
};

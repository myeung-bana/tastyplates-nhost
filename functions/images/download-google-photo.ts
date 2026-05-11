import type { Request, Response } from 'express'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const { photoUrl } = req.body as { photoUrl?: string }

    if (!photoUrl) return fail(res, 'Missing required field: photoUrl', 400)

    let parsedUrl: URL
    try {
      parsedUrl = new URL(photoUrl)
    } catch {
      return fail(res, 'Invalid URL', 400)
    }

    if (!parsedUrl.hostname.endsWith('googleapis.com')) {
      return fail(res, 'Only googleapis.com URLs are allowed', 400)
    }

    const response = await fetch(photoUrl)
    if (!response.ok) {
      return fail(res, `Failed to fetch image: ${response.statusText}`, 502)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') ?? 'image/jpeg'
    const base64 = buffer.toString('base64')
    const base64DataUrl = `data:${contentType};base64,${base64}`

    ok(res, { data: base64DataUrl })
  } catch (error) {
    console.error('[images/download-google-photo]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

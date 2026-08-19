import type { Request, Response } from 'express'
import { getPalateRatingSummary } from '../_lib/palateRatingQueries'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('restaurant_uuid')?.trim() ?? url.searchParams.get('uuid')?.trim()
    const palateSlug = url.searchParams.get('palate_slug')?.trim()

    if (!uuid) return fail(res, 'Missing required param: restaurant_uuid', 400)
    if (!palateSlug) return fail(res, 'Missing required param: palate_slug', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    const data = await getPalateRatingSummary(uuid, palateSlug)
    ok(res, data)
  } catch (error) {
    console.error('[restaurants-v2/get-palate-rating-summary]', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    const status =
      message === 'Restaurant not found'
        ? 404
        : message.startsWith('Unknown leaf palate')
          ? 400
          : 500
    fail(res, message, status)
  }
}

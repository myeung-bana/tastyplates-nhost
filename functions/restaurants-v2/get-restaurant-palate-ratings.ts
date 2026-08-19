import type { Request, Response } from 'express'
import { getRestaurantPalateRatings } from '../_lib/palateRatingQueries'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseSource(raw: string | null): 'all' | 'external' | 'first_party' | 'combined' {
  if (raw === 'external' || raw === 'first_party' || raw === 'combined') return raw
  return 'all'
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('restaurant_uuid')?.trim() ?? url.searchParams.get('uuid')?.trim()
    if (!uuid) return fail(res, 'Missing required param: restaurant_uuid', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    const source = parseSource(url.searchParams.get('review_source'))
    const data = await getRestaurantPalateRatings(uuid, source)
    ok(res, data)
  } catch (error) {
    console.error('[restaurants-v2/get-restaurant-palate-ratings]', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    const status = message === 'Restaurant not found' ? 404 : 500
    fail(res, message, status)
  }
}

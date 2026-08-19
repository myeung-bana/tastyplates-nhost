import type { Request, Response } from 'express'
import { getPreferenceStatsForRestaurant } from '../_lib/palateRatingQueries'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parsePalates(raw: string | null): string[] {
  if (!raw?.trim()) return []
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('restaurant_uuid')?.trim() ?? url.searchParams.get('uuid')?.trim()
    const palates = parsePalates(url.searchParams.get('palates'))

    if (!uuid) return fail(res, 'Missing required param: restaurant_uuid', 400)
    if (palates.length === 0) return fail(res, 'Missing required param: palates', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    const data = await getPreferenceStatsForRestaurant(uuid, palates)
    ok(res, data)
  } catch (error) {
    console.error('[restaurants-v2/get-preference-stats-for-restaurant]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

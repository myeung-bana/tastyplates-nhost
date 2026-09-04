import type { Request, Response } from 'express'
import { getGroupScoresForPalates } from '../_lib/groupScoreQueries'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parsePalatesParam(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
}

function parseRestaurantUuidsParam(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  const uuids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const uuid of uuids) {
    if (!UUID_REGEX.test(uuid)) {
      throw new Error(`Invalid restaurant UUID format: ${uuid}`)
    }
  }
  return [...new Set(uuids)]
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const palates = parsePalatesParam(url.searchParams.get('palates'))
    const restaurantUuids = parseRestaurantUuidsParam(
      url.searchParams.get('restaurant_uuids') ?? url.searchParams.get('uuids'),
    )

    if (palates.length === 0) return fail(res, 'Missing required param: palates', 400)

    const data = await getGroupScoresForPalates(
      palates,
      restaurantUuids.length > 0 ? restaurantUuids : undefined,
    )
    ok(res, data)
  } catch (error) {
    console.error('[restaurants-v2/get-group-scores]', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    const status = message.startsWith('Invalid restaurant UUID') ? 400 : 500
    fail(res, message, status)
  }
}

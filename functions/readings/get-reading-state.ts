import type { Request, Response } from 'express'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'
import { localDay, resolveReadingState } from '../_lib/restaurantReadingStore'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET ?restaurant_uuid=&tz= — which reading card to show (optional Bearer):
 * guest · no_palates · not_enough · daily_limit · ready · pending · default.
 * `tz` is the device's `getTimezoneOffset()` in minutes, so "today" is the viewer's day.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('restaurant_uuid')?.trim() ?? ''
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Missing or invalid param: restaurant_uuid', 400)

    const auth = await resolveOptionalAuth(req, res)
    const day = localDay(Number(url.searchParams.get('tz')))
    ok(res, await resolveReadingState(auth?.userId ?? null, uuid, day))
  } catch (error) {
    console.error('[readings/get-reading-state]', error)
    fail(res, 'Internal server error', 500)
  }
}

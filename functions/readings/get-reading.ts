import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'
import { getReadingById, getReadingForDay, isStale, localDay } from '../_lib/restaurantReadingStore'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET ?id=  or  ?restaurant_uuid=&tz= (today's reading for that restaurant) — one of your readings:
 * job status while it runs, then facts (numbers) and content (text). A failed reading still returns
 * its facts so the app can show group scores. 404 until the job has created its row.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')?.trim() ?? ''
    const restaurantUuid = url.searchParams.get('restaurant_uuid')?.trim() ?? ''
    if (!UUID_REGEX.test(id) && !UUID_REGEX.test(restaurantUuid)) {
      return fail(res, 'Missing or invalid param: id or restaurant_uuid', 400)
    }

    const row = UUID_REGEX.test(id)
      ? await getReadingById(id)
      : await getReadingForDay(auth.userId, restaurantUuid, localDay(Number(url.searchParams.get('tz'))))
    if (!row || row.user_id !== auth.userId) return fail(res, 'Reading not found', 404)

    const stale = isStale(row)
    ok(res, {
      id: row.id,
      restaurant_uuid: row.restaurant_uuid,
      status: stale ? 'failed' : row.status,
      facts: row.facts,
      content: row.status === 'ready' ? row.content : null,
      error: stale ? 'The reading took too long' : row.status === 'failed' ? 'We couldn’t write your reading right now' : null,
      feedback: row.feedback,
      updated_at: row.updated_at,
    })
  } catch (error) {
    console.error('[readings/get-reading]', error)
    fail(res, 'Internal server error', 500)
  }
}

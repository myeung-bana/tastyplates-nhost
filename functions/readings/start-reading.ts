import type { Request, Response } from 'express'
import { z } from 'zod'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'
import { claimReading, localDay, ReadingRefusal, runReading } from '../_lib/restaurantReadingStore'

const StartSchema = z.object({
  restaurant_uuid: z.string().uuid(),
  tz: z.number().int().min(-840).max(840).optional(),
})

/**
 * POST { restaurant_uuid, tz? } — start (or reuse) today's reading. Signed-in only.
 *
 * Runs the whole job inside this request and answers when it ends, so the work isn't cut off when
 * the function returns. The app doesn't wait for this reply: it polls `readings/get-reading` for
 * the step, and the job keeps going if the user closes the screen (cached for next time).
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const parsed = StartSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 'Invalid body: restaurant_uuid is required', 400)

    const day = localDay(parsed.data.tz)
    const { row, run } = await claimReading(auth.userId, parsed.data.restaurant_uuid, day)
    if (run) await runReading(row.id, auth.userId, parsed.data.restaurant_uuid)
    ok(res, { reading_id: row.id })
  } catch (error) {
    if (error instanceof ReadingRefusal) return fail(res, error.message, 409, { state: error.state })
    console.error('[readings/start-reading]', error)
    fail(res, 'Internal server error', 500)
  }
}

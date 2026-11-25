import type { Request, Response } from 'express'
import { z } from 'zod'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'
import { getReadingById, updateReading } from '../_lib/restaurantReadingStore'

const FeedbackSchema = z.object({
  id: z.string().uuid(),
  /** 1 = thumbs up, -1 = thumbs down, null clears it. */
  value: z.union([z.literal(1), z.literal(-1), z.null()]),
})

/** POST { id, value } — thumbs up / down on your reading. */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const parsed = FeedbackSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 'Invalid body', 400)

    const row = await getReadingById(parsed.data.id)
    if (!row || row.user_id !== auth.userId) return fail(res, 'Reading not found', 404)

    await updateReading(row.id, { feedback: parsed.data.value })
    ok(res, { id: row.id, feedback: parsed.data.value })
  } catch (error) {
    console.error('[readings/reading-feedback]', error)
    fail(res, 'Internal server error', 500)
  }
}

import type { Request, Response } from 'express'
import { z } from 'zod'
import { resolveAuth } from '../_lib/auth-guard'
import { blockUser } from '../_lib/userBlocks'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const BlockSchema = z.object({ user_id: z.string().uuid() })

/**
 * POST `blocks/block-user`
 * Bearer required. Body: { user_id }. Also removes follows in both directions.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const body = validate(req, res, BlockSchema)
    if (!body) return
    if (body.user_id.toLowerCase() === auth.userId.toLowerCase()) {
      return fail(res, 'You cannot block yourself', 400)
    }

    await blockUser(auth.userId, body.user_id)
    ok(res, { blocked: true, user_id: body.user_id })
  } catch (error) {
    console.error('[blocks/block-user]', error)
    fail(res, 'Failed to block user', 500)
  }
}

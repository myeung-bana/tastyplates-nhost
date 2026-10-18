import type { Request, Response } from 'express'
import { z } from 'zod'
import { resolveAuth } from '../_lib/auth-guard'
import { unblockUser } from '../_lib/userBlocks'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const UnblockSchema = z.object({ user_id: z.string().uuid() })

/** POST `blocks/unblock-user` — Bearer required. Body: { user_id }. */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const body = validate(req, res, UnblockSchema)
    if (!body) return

    const removed = await unblockUser(auth.userId, body.user_id)
    ok(res, { blocked: false, removed, user_id: body.user_id })
  } catch (error) {
    console.error('[blocks/unblock-user]', error)
    fail(res, 'Failed to unblock user', 500)
  }
}

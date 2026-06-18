import type { Request, Response } from 'express'
import { ensureUserProfile, toPublicProfile } from '../_lib/user-profile'
import { resolveAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const { profile } = await ensureUserProfile(auth.userId)

    ok(res, toPublicProfile(profile))
  } catch (error) {
    console.error('[users/me]', error)
    fail(res, 'Internal server error', 500)
  }
}

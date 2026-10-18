import type { Request, Response } from 'express'
import { getProfileById } from '../_lib/user-profile'
import { resolveAuth } from '../_lib/auth-guard'
import {
  anonymiseAccount,
  DELETION_GRACE_DAYS,
  requestAccountDeletion,
} from '../_lib/accountDeletion'
import { ok, fail } from '../_lib/respond'

/**
 * POST|DELETE `restaurant-users/delete-restaurant-user`
 * Bearer required; acts only on the JWT user.
 *
 * Default: hides the profile, signs out every session and schedules anonymisation in
 * DELETION_GRACE_DAYS days (signing back in can restore). `?immediate=true` anonymises now.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const existing = await getProfileById(auth.userId)
    if (!existing) return fail(res, 'User not found', 404)

    if (req.query.immediate === 'true' || req.query.hard === 'true') {
      await requestAccountDeletion(auth.userId)
      await anonymiseAccount(auth.userId)
      return ok(res, { deleted: true, userId: auth.userId, immediate: true, scheduled_for: null })
    }

    const scheduledFor = await requestAccountDeletion(auth.userId)
    ok(res, {
      deleted: true,
      userId: auth.userId,
      immediate: false,
      scheduled_for: scheduledFor,
      grace_days: DELETION_GRACE_DAYS,
    })
  } catch (error) {
    console.error('[restaurant-users/delete-restaurant-user]', error)
    fail(res, 'Failed to delete account', 500)
  }
}

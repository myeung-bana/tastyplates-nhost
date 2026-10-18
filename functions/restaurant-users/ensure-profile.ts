import type { Request, Response } from 'express'
import { ensureUserProfile, toLegacyUser } from '../_lib/user-profile'
import { resolveAuth } from '../_lib/auth-guard'
import { getDeletionState, isDeletionPending } from '../_lib/accountDeletion'
import { ok, fail } from '../_lib/respond'

/**
 * POST `restaurant-users/ensure-profile`
 * Bearer required. Creates `user_profiles` for the JWT user when missing
 * (`user_<random>` placeholder username, `onboarding_complete: false`).
 * `deletion` is set while the account is inside its deletion grace period.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const { profile, created } = await ensureUserProfile(auth.userId)
    const state = created ? null : await getDeletionState(auth.userId).catch(() => null)
    const deletion = isDeletionPending(state)
      ? { pending: true, scheduled_for: state?.deletion_scheduled_for ?? null }
      : null

    ok(res, { user: toLegacyUser(profile), created, deletion }, created ? 201 : 200)
  } catch (error) {
    console.error('[restaurant-users/ensure-profile]', error)
    fail(res, 'Internal server error', 500)
  }
}

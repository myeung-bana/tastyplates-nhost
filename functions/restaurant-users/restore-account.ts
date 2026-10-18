import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { getDeletionState, isDeletionPending, restoreAccount } from '../_lib/accountDeletion'
import { ok, fail } from '../_lib/respond'

/**
 * POST `restaurant-users/restore-account`
 * Bearer required. Cancels a pending account deletion during the grace period.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const state = await getDeletionState(auth.userId)
    if (!state) return fail(res, 'User not found', 404)
    if (state.anonymized_at) return fail(res, 'Account has already been deleted', 410)
    if (!isDeletionPending(state)) return ok(res, { restored: false, pending: false })

    const restored = await restoreAccount(auth.userId)
    ok(res, { restored, pending: !restored })
  } catch (error) {
    console.error('[restaurant-users/restore-account]', error)
    fail(res, 'Failed to restore account', 500)
  }
}

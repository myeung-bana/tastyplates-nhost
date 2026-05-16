import type { Request, Response } from 'express'
import { softDeleteUserProfile, getProfileById } from '../_lib/user-profile'
import { resolveAuth } from '../_lib/auth-guard'
import { NHOST_AUTH_URL, NHOST_ADMIN_SECRET } from '../_lib/env'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const hard = req.query.hard === 'true'

    const existing = await getProfileById(auth.userId)
    if (!existing) return fail(res, 'User not found', 404)

    if (hard) {
      const deleteRes = await fetch(`${NHOST_AUTH_URL}/v1/users/${auth.userId}`, {
        method: 'DELETE',
        headers: {
          'x-hasura-admin-secret': NHOST_ADMIN_SECRET,
        },
      })

      if (!deleteRes.ok) {
        const text = await deleteRes.text().catch(() => '')
        console.error(
          '[restaurant-users/delete-restaurant-user] hard delete failed',
          deleteRes.status,
          text,
        )
        return fail(res, 'Failed to delete account', 500)
      }
    } else {
      await softDeleteUserProfile(auth.userId)
    }

    ok(res, { deleted: true, userId: auth.userId, hard })
  } catch (error) {
    console.error('[restaurant-users/delete-restaurant-user]', error)
    fail(res, 'Internal server error', 500)
  }
}

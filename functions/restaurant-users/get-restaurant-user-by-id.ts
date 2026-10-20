import type { Request, Response } from 'express'
import { getProfileById, toLegacyUser, toOwnLegacyUser } from '../_lib/user-profile'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined
    if (!id) return fail(res, 'Missing required param: id', 400)
    if (!UUID_REGEX.test(id)) return fail(res, 'Invalid UUID format', 400)

    const profile = await getProfileById(id)
    if (!profile) return fail(res, 'User not found', 404)

    const viewer = await resolveOptionalAuth(req, res)
    const isSelf = viewer?.userId === profile.user.id
    if (profile.deleted_at && !isSelf) return fail(res, 'User not found', 404)

    // First / last name are private: only the account owner gets them.
    ok(res, { user: isSelf ? toOwnLegacyUser(profile) : toLegacyUser(profile) })
  } catch (error) {
    console.error('[restaurant-users/get-restaurant-user-by-id]', error)
    fail(res, 'Internal server error', 500)
  }
}

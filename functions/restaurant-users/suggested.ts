import type { Request, Response } from 'express'
import { listSuggestedProfiles, toLegacyUser } from '../_lib/user-profile'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 50)
    const auth = await resolveOptionalAuth(req, res)

    const profiles = await listSuggestedProfiles({
      limit,
      excludeUserId: auth?.userId,
    })

    const users = profiles.map((p) => ({
      ...toLegacyUser(p),
      review_count: 0,
      follower_count: 0,
    }))

    ok(res, { users })
  } catch (error) {
    console.error('[restaurant-users/suggested]', error)
    fail(res, 'Internal server error', 500)
  }
}

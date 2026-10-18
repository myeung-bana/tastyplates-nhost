import type { Request, Response } from 'express'
import { listSuggestedProfiles, toLegacyUser } from '../_lib/user-profile'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'
import { getHiddenUserIds, isHidden } from '../_lib/userBlocks'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 50)
    const auth = await resolveOptionalAuth(req, res)

    const [profiles, hidden] = await Promise.all([
      listSuggestedProfiles({ limit, excludeUserId: auth?.userId }),
      auth ? getHiddenUserIds(auth.userId) : Promise.resolve(new Set<string>()),
    ])

    const users = profiles.filter((p) => !isHidden(hidden, p.user.id)).map((p) => ({
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

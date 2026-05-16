import type { Request, Response } from 'express'
import { listProfiles, toLegacyUser } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 1000)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined

    if (Number.isNaN(limit)) return fail(res, 'Invalid limit', 400)

    const where = search
      ? {
          _or: [
            { username: { _ilike: `%${search}%` } },
            { user: { displayName: { _ilike: `%${search}%` } } },
            { user: { email: { _ilike: `%${search}%` } } },
          ],
        }
      : undefined

    const { profiles, total } = await listProfiles({ limit, offset, where })
    const users = profiles.map(toLegacyUser)

    ok(res, {
      users,
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + users.length < total,
      },
    })
  } catch (error) {
    console.error('[restaurant-users/get-restaurant-users]', error)
    fail(res, 'Internal server error', 500)
  }
}

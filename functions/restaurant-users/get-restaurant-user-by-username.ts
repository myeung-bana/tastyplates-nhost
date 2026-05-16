import type { Request, Response } from 'express'
import { getProfileByUsername, toLegacyUser } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : undefined
    if (!username) return fail(res, 'Missing required param: username', 400)

    const profile = await getProfileByUsername(username)
    if (!profile) return fail(res, 'User not found', 404)

    ok(res, { user: toLegacyUser(profile) })
  } catch (error) {
    console.error('[restaurant-users/get-restaurant-user-by-username]', error)
    fail(res, 'Internal server error', 500)
  }
}

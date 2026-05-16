import type { Request, Response } from 'express'
import { isUsernameTaken } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : undefined
    if (!username) return fail(res, 'Missing required param: username', 400)

    const taken = await isUsernameTaken(username)
    ok(res, { available: !taken })
  } catch (error) {
    console.error('[restaurant-users/check-username]', error)
    fail(res, 'Internal server error', 500)
  }
}

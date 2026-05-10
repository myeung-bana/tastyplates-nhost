import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const FOLLOW_USER = `
  mutation FollowUser($followerId: uuid!, $userId: uuid!) {
    insert_restaurant_user_follows_one(object: { follower_id: $followerId user_id: $userId }) {
      id follower_id user_id created_at
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const followerId = getUserId(payload)
    const { user_id } = req.body as { user_id?: string }

    if (!user_id) return fail(res, 'Missing required field: user_id', 400)
    if (!UUID_REGEX.test(user_id)) return fail(res, 'Invalid UUID format', 400)

    type Result = { insert_restaurant_user_follows_one: unknown }
    const result = await hasuraMutation<Result>(FOLLOW_USER, { followerId, userId: user_id })

    if (result.errors?.length) {
      console.error('[restaurant-users/follow]', result.errors)
      return fail(res, 'Failed to follow user', 500)
    }

    ok(res, { followed: true })
  } catch (error) {
    console.error('[restaurant-users/follow]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const UNFOLLOW_USER = `
  mutation UnfollowUser($followerId: uuid!, $userId: uuid!) {
    delete_restaurant_user_follows(where: { follower_id: { _eq: $followerId } user_id: { _eq: $userId } }) {
      affected_rows returning { id }
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

    type Result = { delete_restaurant_user_follows: { affected_rows: number; returning: Array<{ id: string }> } }
    await hasuraMutation<Result>(UNFOLLOW_USER, { followerId, userId: user_id })

    ok(res, { unfollowed: true })
  } catch (error) {
    console.error('[restaurant-users/unfollow]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

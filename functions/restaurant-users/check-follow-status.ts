import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const CHECK_FOLLOW_STATUS = `
  query CheckFollowStatus($followerId: uuid!, $userId: uuid!) {
    restaurant_user_follows(
      where: { follower_id: { _eq: $followerId } user_id: { _eq: $userId } }
      limit: 1
    ) { id }
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

    type Result = { restaurant_user_follows: Array<{ id: string }> }
    const result = await hasuraQuery<Result>(CHECK_FOLLOW_STATUS, { followerId, userId: user_id })

    if (result.errors?.length) {
      console.error('[restaurant-users/check-follow-status]', result.errors)
      return fail(res, 'Failed to check follow status', 500)
    }

    const rows = result.data?.restaurant_user_follows ?? []
    ok(res, { is_following: rows.length > 0 })
  } catch (error) {
    console.error('[restaurant-users/check-follow-status]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

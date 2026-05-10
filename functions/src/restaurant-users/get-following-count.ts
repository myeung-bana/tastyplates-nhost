import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_FOLLOWING_COUNT = `
  query GetFollowingCount($userId: uuid!) {
    restaurant_user_follows_aggregate(where: { follower_id: { _eq: $userId } }) { aggregate { count } }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const userId = url.searchParams.get('userId')

    if (!userId) return fail(res, 'Missing required param: userId', 400)
    if (!UUID_REGEX.test(userId)) return fail(res, 'Invalid UUID format', 400)

    type Result = { restaurant_user_follows_aggregate: { aggregate: { count: number } } }
    const result = await hasuraQuery<Result>(GET_FOLLOWING_COUNT, { userId })

    if (result.errors?.length) {
      console.error('[restaurant-users/get-following-count]', result.errors)
      return fail(res, 'Failed to fetch following count', 500)
    }

    const count = result.data?.restaurant_user_follows_aggregate.aggregate.count ?? 0
    ok(res, { userId, followingCount: count })
  } catch (error) {
    console.error('[restaurant-users/get-following-count]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

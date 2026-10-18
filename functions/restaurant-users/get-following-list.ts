import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { getProfilesByIds, toFollowListUser } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'
import { getHiddenUserIdsForRequest, isHidden } from '../_lib/userBlocks'

const GET_FOLLOWING_LIST = `
  query GetFollowingList($userId: uuid!, $limit: Int, $offset: Int) {
    restaurant_user_follows(
      where: { follower_id: { _eq: $userId } }
      limit: $limit
      offset: $offset
      order_by: { created_at: desc }
    ) {
      id
      created_at
      follower_id
      user_id
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const userId =
      (typeof req.query.userId === 'string' ? req.query.userId : undefined) ??
      (typeof req.query.user_id === 'string' ? req.query.user_id : undefined)
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    if (!userId) return fail(res, 'Missing required param: userId', 400)
    if (!UUID_REGEX.test(userId)) return fail(res, 'Invalid UUID format', 400)

    type FollowsResult = {
      restaurant_user_follows: Array<{
        id: string
        created_at: string
        follower_id: string
        user_id: string
      }>
    }

    const followsResult = await hasuraAdmin<FollowsResult>(GET_FOLLOWING_LIST, {
      userId,
      limit,
      offset,
    })

    const follows = followsResult.restaurant_user_follows ?? []
    const followingIds = follows.map((f) => f.user_id)

    if (followingIds.length === 0) return ok(res, { following: [] })

    const [profiles, hidden] = await Promise.all([
      getProfilesByIds(followingIds),
      getHiddenUserIdsForRequest(req, res),
    ])
    const userMap = new Map(profiles.map((p) => [p.user.id, toFollowListUser(p)]))

    const following = follows
      .filter((f) => userMap.has(f.user_id) && !isHidden(hidden, f.user_id))
      .map((f) => ({
        follow_id: f.id,
        followed_at: f.created_at,
        user: userMap.get(f.user_id) ?? null,
      }))

    ok(res, { following })
  } catch (error) {
    console.error('[restaurant-users/get-following-list]', error)
    fail(res, 'Internal server error', 500)
  }
}

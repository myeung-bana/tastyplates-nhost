import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { getProfilesByIds, toFollowListUser } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

const GET_FOLLOWERS_LIST = `
  query GetFollowersList($userId: uuid!, $limit: Int, $offset: Int) {
    restaurant_user_follows(
      where: { user_id: { _eq: $userId } }
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

    const followsResult = await hasuraAdmin<FollowsResult>(GET_FOLLOWERS_LIST, {
      userId,
      limit,
      offset,
    })

    if (followsResult.errors?.length) {
      console.error('[restaurant-users/get-followers-list]', followsResult.errors)
      return fail(res, 'Failed to fetch followers', 500)
    }

    const follows = followsResult.data?.restaurant_user_follows ?? []
    const followerIds = follows.map((f) => f.follower_id)

    if (followerIds.length === 0) return ok(res, { followers: [] })

    const profiles = await getProfilesByIds(followerIds)
    const userMap = new Map(profiles.map((p) => [p.user.id, toFollowListUser(p)]))

    const followers = follows.map((f) => ({
      follow_id: f.id,
      followed_at: f.created_at,
      user: userMap.get(f.follower_id) ?? null,
    }))

    ok(res, { followers })
  } catch (error) {
    console.error('[restaurant-users/get-followers-list]', error)
    fail(res, 'Internal server error', 500)
  }
}

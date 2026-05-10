import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_FOLLOWING_LIST = `
  query GetFollowingList($userId: uuid!, $limit: Int, $offset: Int) {
    restaurant_user_follows(
      where: { follower_id: { _eq: $userId } }
      limit: $limit offset: $offset order_by: { created_at: desc }
    ) { id created_at follower_id user_id }
  }
`

const GET_USERS_BY_IDS = `
  query GetUsersByIds($ids: [uuid!]!) {
    restaurant_users(where: { id: { _in: $ids } }) {
      id username display_name profile_image about_me
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const userId = url.searchParams.get('userId')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!userId) return fail(res, 'Missing required param: userId', 400)
    if (!UUID_REGEX.test(userId)) return fail(res, 'Invalid UUID format', 400)

    type FollowsResult = { restaurant_user_follows: Array<{ id: string; created_at: string; follower_id: string; user_id: string }> }
    const followsResult = await hasuraQuery<FollowsResult>(GET_FOLLOWING_LIST, { userId, limit, offset })

    if (followsResult.errors?.length) {
      console.error('[restaurant-users/get-following-list]', followsResult.errors)
      return fail(res, 'Failed to fetch following list', 500)
    }

    const follows = followsResult.data?.restaurant_user_follows ?? []
    const followingIds = follows.map(f => f.user_id)

    if (followingIds.length === 0) return ok(res, { following: [] })

    type UsersResult = { restaurant_users: Array<{ id: string; username: string; display_name: string | null; profile_image: string | null; about_me: string | null }> }
    const usersResult = await hasuraQuery<UsersResult>(GET_USERS_BY_IDS, { ids: followingIds })

    if (usersResult.errors?.length) {
      console.error('[restaurant-users/get-following-list]', usersResult.errors)
      return fail(res, 'Failed to fetch user details', 500)
    }

    const userMap = new Map((usersResult.data?.restaurant_users ?? []).map(u => [u.id, u]))
    const following = follows.map(f => ({
      follow_id: f.id,
      followed_at: f.created_at,
      user: userMap.get(f.user_id) ?? null,
    }))

    ok(res, { following })
  } catch (error) {
    console.error('[restaurant-users/get-following-list]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

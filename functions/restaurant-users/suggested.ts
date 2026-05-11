import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { requireAuth, getUserId } from '../_lib/auth'

const GET_SUGGESTED_USERS = `
  query GetSuggestedUsers($limit: Int!, $excludeUserId: uuid) {
    restaurant_users(
      where: { _and: [{ id: { _neq: $excludeUserId } } { review_count: { _gt: 0 } }] }
      order_by: [{ follower_count: desc_nulls_last } { review_count: desc }]
      limit: $limit
    ) { id username display_name profile_image review_count follower_count about_me }
  }
`

const GET_SUGGESTED_USERS_ANON = `
  query GetSuggestedUsersAnon($limit: Int!) {
    restaurant_users(
      where: { review_count: { _gt: 0 } }
      order_by: [{ follower_count: desc_nulls_last } { review_count: desc }]
      limit: $limit
    ) { id username display_name profile_image review_count follower_count about_me }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '6'), 50)

    let excludeUserId: string | undefined

    if (req.headers.authorization?.startsWith('Bearer ')) {
      const payload = await requireAuth(req, res)
      if (!payload) return
      excludeUserId = getUserId(payload)
    }

    type Result = { restaurant_users: unknown[] }
    const result = excludeUserId
      ? await hasuraQuery<Result>(GET_SUGGESTED_USERS, { limit, excludeUserId })
      : await hasuraQuery<Result>(GET_SUGGESTED_USERS_ANON, { limit })

    if (result.errors?.length) {
      console.error('[restaurant-users/suggested]', result.errors)
      return fail(res, 'Failed to fetch suggested users', 500)
    }

    ok(res, { users: result.data?.restaurant_users ?? [] })
  } catch (error) {
    console.error('[restaurant-users/suggested]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

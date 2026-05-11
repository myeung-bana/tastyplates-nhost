import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_ALL_RESTAURANT_USERS = `
  query GetAllRestaurantUsers($where: restaurant_users_bool_exp, $limit: Int, $offset: Int) {
    restaurant_users(where: $where limit: $limit offset: $offset order_by: { created_at: desc }) {
      id username email display_name profile_image about_me palates onboarding_complete created_at
    }
    restaurant_users_aggregate(where: $where) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const search = url.searchParams.get('search') ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 1000)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (isNaN(limit)) return fail(res, 'Invalid limit', 400)

    const conditions: Record<string, unknown>[] = []
    if (search) {
      conditions.push({
        _or: [
          { username: { _ilike: `%${search}%` } },
          { display_name: { _ilike: `%${search}%` } },
          { email: { _ilike: `%${search}%` } },
        ],
      })
    }

    const where = conditions.length > 0 ? { _and: conditions } : {}

    type Result = {
      restaurant_users: unknown[]
      restaurant_users_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<Result>(GET_ALL_RESTAURANT_USERS, { where, limit, offset })

    if (result.errors?.length) {
      console.error('[restaurant-users/get-restaurant-users]', result.errors)
      return fail(res, 'Failed to fetch users', 500)
    }

    const users = result.data?.restaurant_users ?? []
    const total = result.data?.restaurant_users_aggregate.aggregate.count ?? 0

    ok(res, { users, meta: { total, limit, offset, hasMore: offset + users.length < total } })
  } catch (error) {
    console.error('[restaurant-users/get-restaurant-users]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

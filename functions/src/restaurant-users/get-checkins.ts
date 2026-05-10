import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_USER_CHECKINS = `
  query GetUserCheckins($user_id: uuid!, $limit: Int, $offset: Int) {
    user_checkins(where: { user_id: { _eq: $user_id } } limit: $limit offset: $offset order_by: { checked_in_at: desc }) {
      id checked_in_at restaurant_uuid
    }
    user_checkins_aggregate(where: { user_id: { _eq: $user_id } }) { aggregate { count } }
  }
`

const GET_RESTAURANTS_BY_UUIDS = `
  query GetRestaurantsByUuids($uuids: [uuid!]!) {
    restaurants(where: { uuid: { _in: $uuids } }) {
      id uuid title slug status average_rating ratings_count price_range_id
      featured_image_url listing_street address cuisines palates categories
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const userId = url.searchParams.get('user_id')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!userId) return fail(res, 'Missing required param: user_id', 400)
    if (!UUID_REGEX.test(userId)) return fail(res, 'Invalid UUID format', 400)

    type CheckinsResult = {
      user_checkins: Array<{ id: string; checked_in_at: string; restaurant_uuid: string }>
      user_checkins_aggregate: { aggregate: { count: number } }
    }

    const checkinsResult = await hasuraQuery<CheckinsResult>(GET_USER_CHECKINS, { user_id: userId, limit, offset })

    if (checkinsResult.errors?.length) {
      console.error('[restaurant-users/get-checkins]', checkinsResult.errors)
      return fail(res, 'Failed to fetch checkins', 500)
    }

    const checkins = checkinsResult.data?.user_checkins ?? []
    const total = checkinsResult.data?.user_checkins_aggregate.aggregate.count ?? 0

    if (checkins.length === 0) {
      return ok(res, { items: [], meta: { total, limit, offset, hasMore: false } })
    }

    const uuids = checkins.map(c => c.restaurant_uuid)

    type RestaurantsResult = { restaurants: Array<{ uuid: string; [key: string]: unknown }> }
    const restResult = await hasuraQuery<RestaurantsResult>(GET_RESTAURANTS_BY_UUIDS, { uuids })

    if (restResult.errors?.length) {
      console.error('[restaurant-users/get-checkins]', restResult.errors)
      return fail(res, 'Failed to fetch restaurant details', 500)
    }

    const restaurantMap = new Map((restResult.data?.restaurants ?? []).map(r => [r.uuid, r]))
    const items = checkins.map(c => ({
      checkin_id: c.id,
      checked_in_at: c.checked_in_at,
      restaurant: restaurantMap.get(c.restaurant_uuid) ?? null,
    }))

    ok(res, { items, meta: { total, limit, offset, hasMore: offset + checkins.length < total } })
  } catch (error) {
    console.error('[restaurant-users/get-checkins]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

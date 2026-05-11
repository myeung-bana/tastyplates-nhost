import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_RESTAURANTS_LIST = `
  query GetRestaurantsList($limit: Int, $offset: Int, $where: restaurants_bool_exp, $order_by: [restaurants_order_by!]) {
    restaurants(limit: $limit offset: $offset where: $where order_by: $order_by) {
      id uuid title slug status price_range_id average_rating ratings_count listing_street
      longitude latitude featured_image_url address cuisines palates categories
      is_main_location created_at updated_at published_at
    }
    restaurants_aggregate(where: $where) { aggregate { count } }
  }
`

const SMART_SORT_SUMMARIES = `
  query SmartSortSummaries {
    restaurant_rating_summary(order_by: [{ authentic_rating_weighted: desc_nulls_last }, { restaurant_id: desc }]) {
      restaurant_id authentic_rating_weighted
    }
  }
`

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function encodeRestaurantCursor(created_at: string, id: number): string {
  return Buffer.from(JSON.stringify({ created_at, id })).toString('base64url')
}

function decodeRestaurantCursor(cursor: string): { created_at: string; id: number } | null {
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { return null }
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const limitParam = parseInt(url.searchParams.get('limit') ?? '100')
    const limit = isNaN(limitParam) ? 100 : Math.max(1, Math.min(limitParam, 1000))
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0
    const cursor = url.searchParams.get('cursor') ?? undefined
    const status = url.searchParams.get('status') ?? 'publish'
    const search = url.searchParams.get('search') ?? undefined
    const cuisine_ids = url.searchParams.get('cuisine_ids')?.split(',').map(Number).filter(n => !isNaN(n))
    const cuisine_slugs = url.searchParams.get('cuisine_slugs')?.split(',').filter(Boolean)
    const palate_ids = url.searchParams.get('palate_ids')?.split(',').map(Number).filter(n => !isNaN(n))
    const palate_slugs = url.searchParams.get('palate_slugs')?.split(',').filter(Boolean)
    const category_ids = url.searchParams.get('category_ids')?.split(',').map(Number).filter(n => !isNaN(n))
    const price_range_id = url.searchParams.get('price_range_id') ? parseInt(url.searchParams.get('price_range_id')!) : undefined
    const min_rating = url.searchParams.get('min_rating') ? parseFloat(url.searchParams.get('min_rating')!) : undefined
    const max_rating = url.searchParams.get('max_rating') ? parseFloat(url.searchParams.get('max_rating')!) : undefined
    const latitude = url.searchParams.get('latitude') ? parseFloat(url.searchParams.get('latitude')!) : undefined
    const longitude = url.searchParams.get('longitude') ? parseFloat(url.searchParams.get('longitude')!) : undefined
    const radius_km = url.searchParams.get('radius_km') ? parseFloat(url.searchParams.get('radius_km')!) : undefined
    const is_main_location = url.searchParams.get('is_main_location') === 'true' ? true : undefined
    const city_name = url.searchParams.get('city_name') ?? undefined
    const country_short = url.searchParams.get('country_short') ?? undefined
    const order_by_param = url.searchParams.get('order_by') ?? 'created_at_desc'

    const conditions: Record<string, unknown>[] = []

    if (status) conditions.push({ status: { _eq: status } })
    if (search) {
      conditions.push({
        _or: [
          { title: { _ilike: `%${search}%` } },
          { listing_street: { _ilike: `%${search}%` } },
        ],
      })
    }
    if (cuisine_ids?.length) conditions.push({ cuisines: { _contains: cuisine_ids.map(id => ({ id })) } })
    if (cuisine_slugs?.length) conditions.push({ cuisines: { _contains: cuisine_slugs.map(slug => ({ slug })) } })
    if (palate_ids?.length) conditions.push({ palates: { _contains: palate_ids.map(id => ({ id })) } })
    if (palate_slugs?.length) conditions.push({ palates: { _contains: palate_slugs.map(slug => ({ slug })) } })
    if (category_ids?.length) conditions.push({ categories: { _contains: category_ids.map(id => ({ id })) } })
    if (price_range_id !== undefined && !isNaN(price_range_id)) conditions.push({ price_range_id: { _eq: price_range_id } })
    if (min_rating !== undefined && !isNaN(min_rating)) conditions.push({ average_rating: { _gte: min_rating } })
    if (max_rating !== undefined && !isNaN(max_rating)) conditions.push({ average_rating: { _lte: max_rating } })
    if (is_main_location !== undefined) conditions.push({ is_main_location: { _eq: is_main_location } })
    if (city_name) conditions.push({ address: { _contains: { city: city_name } } })
    if (country_short) conditions.push({ address: { _contains: { country_short } } })

    // Cursor condition
    if (cursor) {
      const decoded = decodeRestaurantCursor(cursor)
      if (decoded) {
        conditions.push({
          _or: [
            { created_at: { _lt: decoded.created_at } },
            { _and: [{ created_at: { _eq: decoded.created_at } }, { id: { _lt: decoded.id } }] },
          ],
        })
      }
    }

    const where = conditions.length > 0 ? { _and: conditions } : {}

    // Build order_by
    let order_by: Record<string, string>[] = [{ created_at: 'desc' }, { id: 'desc' }]
    const needsSmartSort = order_by_param === 'smart' || order_by_param === 'rating_desc'

    if (order_by_param === 'rating_desc') {
      order_by = [{ average_rating: 'desc_nulls_last' }, { ratings_count: 'desc' }]
    } else if (order_by_param === 'rating_asc') {
      order_by = [{ average_rating: 'asc_nulls_last' }]
    } else if (order_by_param === 'name_asc') {
      order_by = [{ title: 'asc' }]
    } else if (order_by_param === 'name_desc') {
      order_by = [{ title: 'desc' }]
    } else if (order_by_param !== 'smart') {
      order_by = [{ created_at: 'desc' }, { id: 'desc' }]
    }

    type RestaurantsResult = {
      restaurants: Array<{
        id: number; uuid: string; title: string; slug: string; status: string
        price_range_id: number | null; average_rating: number | null; ratings_count: number | null
        listing_street: string | null; longitude: number | null; latitude: number | null
        featured_image_url: string | null; address: unknown; cuisines: unknown; palates: unknown
        categories: unknown; is_main_location: boolean | null; created_at: string
        updated_at: string; published_at: string | null
      }>
      restaurants_aggregate: { aggregate: { count: number } }
    }

    let variables: Record<string, unknown> = { limit, where, order_by }
    if (!cursor) variables.offset = offset

    // For smart sort, fetch without ordering and sort client-side
    if (needsSmartSort && order_by_param === 'smart') {
      variables.order_by = [{ id: 'desc' }]
    }

    const result = await hasuraQuery<RestaurantsResult>(GET_RESTAURANTS_LIST, variables)

    if (result.errors?.length) {
      console.error('[restaurants-v2/get-restaurants]', result.errors)
      return fail(res, 'Failed to fetch restaurants', 500)
    }

    let restaurants = result.data?.restaurants ?? []
    const total = result.data?.restaurants_aggregate.aggregate.count ?? 0

    // Smart sort: re-order by authentic_rating_weighted
    if (needsSmartSort && order_by_param === 'smart') {
      type SmartSortResult = { restaurant_rating_summary: Array<{ restaurant_id: number; authentic_rating_weighted: number | null }> }
      const summaryResult = await hasuraQuery<SmartSortResult>(SMART_SORT_SUMMARIES)
      const summaryMap = new Map<number, number>()
      for (const s of summaryResult.data?.restaurant_rating_summary ?? []) {
        summaryMap.set(s.restaurant_id, s.authentic_rating_weighted ?? 0)
      }
      restaurants = [...restaurants].sort((a, b) => (summaryMap.get(b.id) ?? 0) - (summaryMap.get(a.id) ?? 0))
    }

    // Distance filter and sort
    let filteredRestaurants = restaurants
    if (latitude !== undefined && longitude !== undefined && !isNaN(latitude) && !isNaN(longitude)) {
      filteredRestaurants = restaurants
        .map(r => ({
          ...r,
          _distance: r.latitude !== null && r.longitude !== null
            ? calculateDistance(latitude, longitude, r.latitude, r.longitude)
            : null,
        }))
        .filter(r => radius_km === undefined || r._distance === null || r._distance <= radius_km)
        .sort((a, b) => (a._distance ?? Infinity) - (b._distance ?? Infinity))
    }

    // Build next cursor
    const lastItem = filteredRestaurants[filteredRestaurants.length - 1]
    const nextCursor = lastItem
      ? encodeRestaurantCursor(lastItem.created_at, lastItem.id)
      : null

    const hasMore = cursor
      ? filteredRestaurants.length === limit
      : offset + filteredRestaurants.length < total

    ok(res, {
      restaurants: filteredRestaurants,
      meta: { total, limit, offset: cursor ? undefined : offset, cursor: nextCursor, hasMore, fetchedAt: new Date().toISOString() },
    })
  } catch (error) {
    console.error('[restaurants-v2/get-restaurants]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

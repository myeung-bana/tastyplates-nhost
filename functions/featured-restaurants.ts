import type { Request, Response } from 'express'
import { hasuraQuery } from './_lib/hasura'
import { ok, fail } from './_lib/respond'

const GET_FEATURED_RESTAURANTS = `
  query GetFeaturedRestaurants {
    featured_restaurants(
      where: { is_active: { _eq: true } }
      order_by: { sort_order: asc }
    ) {
      id restaurant_id sort_order
      restaurant { id uuid title slug featured_image_url listing_street address average_rating ratings_count }
    }
  }
`

const GET_FEATURED_RESTAURANTS_FALLBACK = `
  query GetFeaturedRestaurantsFallback {
    featured_restaurants(
      where: { is_active: { _eq: true } }
      order_by: { sort_order: asc }
    ) { id restaurant_id sort_order }
  }
`

export default async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await hasuraQuery(GET_FEATURED_RESTAURANTS)

    if (result.errors?.length) {
      console.error('[featured-restaurants] primary query failed, trying fallback', result.errors)
      const fallback = await hasuraQuery(GET_FEATURED_RESTAURANTS_FALLBACK)
      if (fallback.errors?.length) {
        console.error('[featured-restaurants] fallback failed', fallback.errors)
        return fail(res, 'Failed to fetch featured restaurants', 500)
      }
      const data = fallback.data as { featured_restaurants?: unknown[] } | null
      return ok(res, data?.featured_restaurants ?? [])
    }

    const data = result.data as { featured_restaurants?: unknown[] } | null
    ok(res, data?.featured_restaurants ?? [])
  } catch (error) {
    console.error('[featured-restaurants]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

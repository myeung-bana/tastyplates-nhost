import type { Request, Response } from 'express'
import { applyFeaturedImageFromPlaceCacheOne } from '../_lib/applyFeaturedImageFallback'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_RESTAURANT_BY_UUID = `
  query GetRestaurantByUuid($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } } limit: 1) {
      id uuid title slug status content price_range_id average_rating ratings_count listing_street
      phone menu_url longitude latitude google_zoom featured_image_url uploaded_images google_place_id
      opening_hours address created_at updated_at published_at cuisines palates categories
    }
  }
`

const GET_RESTAURANT_BY_SLUG = `
  query GetRestaurantBySlug($slug: String!) {
    restaurants(where: { slug: { _eq: $slug } } limit: 1) {
      id uuid title slug status content price_range_id average_rating ratings_count listing_street
      phone menu_url longitude latitude google_zoom featured_image_url uploaded_images google_place_id
      opening_hours address created_at updated_at published_at cuisines palates categories
    }
  }
`

const GET_RESTAURANT_BY_NUMERIC_ID = `
  query GetRestaurantById($id: Int!) {
    restaurants(where: { id: { _eq: $id } } limit: 1) {
      id uuid title slug status content price_range_id average_rating ratings_count listing_street
      phone menu_url longitude latitude google_zoom featured_image_url uploaded_images google_place_id
      opening_hours address created_at updated_at published_at cuisines palates categories
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuidParam = url.searchParams.get('uuid')
    const slugParam = url.searchParams.get('slug')
    const idParam = url.searchParams.get('id')

    type RestaurantsResult = { restaurants: unknown[] }
    let result: Awaited<ReturnType<typeof hasuraQuery<RestaurantsResult>>>

    if (uuidParam) {
      if (!UUID_REGEX.test(uuidParam)) return fail(res, 'Invalid UUID format', 400)
      result = await hasuraQuery<RestaurantsResult>(GET_RESTAURANT_BY_UUID, { uuid: uuidParam })
    } else if (slugParam) {
      result = await hasuraQuery<RestaurantsResult>(GET_RESTAURANT_BY_SLUG, { slug: slugParam })
    } else if (idParam) {
      const id = parseInt(idParam)
      if (isNaN(id)) return fail(res, 'Invalid id: must be an integer', 400)
      result = await hasuraQuery<RestaurantsResult>(GET_RESTAURANT_BY_NUMERIC_ID, { id })
    } else {
      return fail(res, 'Missing required param: uuid, slug, or id', 400)
    }

    if (result.errors?.length) {
      console.error('[restaurants-v2/get-restaurant-by-id]', result.errors)
      return fail(res, 'Failed to fetch restaurant', 500)
    }

    const restaurant = result.data?.restaurants?.[0]
    if (!restaurant) return fail(res, 'Restaurant not found', 404)

    const enrichedRestaurant = await applyFeaturedImageFromPlaceCacheOne(restaurant)

    ok(res, { restaurant: enrichedRestaurant })
  } catch (error) {
    console.error('[restaurants-v2/get-restaurant-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

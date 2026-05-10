import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const MATCH_RESTAURANT_BY_PLACE_ID = `
  query MatchRestaurantByPlaceId($placeId: String!) {
    restaurants(where: { address: { _contains: { place_id: $placeId } } } limit: 1) {
      id uuid title slug status listing_street phone longitude latitude featured_image_url average_rating ratings_count address
    }
  }
`

const MATCH_RESTAURANT_BY_NAME_ADDRESS = `
  query MatchRestaurantByNameAndAddress($name: String!, $address: String!) {
    restaurants(where: { _and: [{ title: { _ilike: $name } }, { listing_street: { _ilike: $address } }] } limit: 5) {
      id uuid title slug status listing_street phone longitude latitude featured_image_url average_rating ratings_count address
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const { placeId, name, address } = req.body as { placeId?: string; name?: string; address?: string }

    type RestaurantsResult = { restaurants: unknown[] }

    if (placeId) {
      const result = await hasuraQuery<RestaurantsResult>(MATCH_RESTAURANT_BY_PLACE_ID, { placeId })
      if (result.errors?.length) {
        console.error('[restaurants-v2/match-restaurant]', result.errors)
        return fail(res, 'Failed to match restaurant', 500)
      }
      const restaurants = result.data?.restaurants ?? []
      if (restaurants.length > 0) return ok(res, { matched: restaurants })
    }

    if (name && address) {
      const result = await hasuraQuery<RestaurantsResult>(MATCH_RESTAURANT_BY_NAME_ADDRESS, {
        name: `%${name}%`,
        address: `%${address}%`,
      })
      if (result.errors?.length) {
        console.error('[restaurants-v2/match-restaurant]', result.errors)
        return fail(res, 'Failed to match restaurant', 500)
      }
      return ok(res, { matched: result.data?.restaurants ?? [] })
    }

    ok(res, { matched: [] })
  } catch (error) {
    console.error('[restaurants-v2/match-restaurant]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

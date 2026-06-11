import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const MATCH_RESTAURANT_BY_GOOGLE_PLACE_ID = `
  query MatchRestaurantByGooglePlaceId($placeId: String!) {
    restaurants(where: { google_place_id: { _eq: $placeId } } limit: 1) {
      id uuid title slug status listing_street phone longitude latitude featured_image_url average_rating ratings_count address
    }
  }
`

const MATCH_RESTAURANT_BY_ADDRESS_PLACE_ID = `
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

type RestaurantsResult = { restaurants: unknown[] }

async function queryMatch(
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown[]> {
  const result = await hasuraQuery<RestaurantsResult>(query, variables)
  if (result.errors?.length) {
    console.error('[restaurants-v2/match-restaurant]', result.errors)
    throw new Error('Failed to match restaurant')
  }
  return result.data?.restaurants ?? []
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const { placeId, name, address } = req.body as {
      placeId?: string
      name?: string
      address?: string
    }

    const trimmedPlaceId = placeId?.trim()

    if (trimmedPlaceId) {
      try {
        const byColumn = await queryMatch(MATCH_RESTAURANT_BY_GOOGLE_PLACE_ID, {
          placeId: trimmedPlaceId,
        })
        if (byColumn.length > 0) return ok(res, { matched: byColumn })
      } catch (columnErr) {
        // Column may not exist until migration runs — fall through to JSON match.
        console.warn('[restaurants-v2/match-restaurant] google_place_id lookup skipped', columnErr)
      }

      const byAddressJson = await queryMatch(MATCH_RESTAURANT_BY_ADDRESS_PLACE_ID, {
        placeId: trimmedPlaceId,
      })
      if (byAddressJson.length > 0) return ok(res, { matched: byAddressJson })
    }

    if (name?.trim() && address?.trim()) {
      const fuzzy = await queryMatch(MATCH_RESTAURANT_BY_NAME_ADDRESS, {
        name: `%${name.trim()}%`,
        address: `%${address.trim()}%`,
      })
      return ok(res, { matched: fuzzy })
    }

    ok(res, { matched: [] })
  } catch (error) {
    console.error('[restaurants-v2/match-restaurant]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

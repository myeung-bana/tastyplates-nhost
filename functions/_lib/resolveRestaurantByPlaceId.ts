import { hasuraQuery } from './hasura'

const MATCH_BY_GOOGLE_PLACE_ID = `
  query MatchRestaurantByGooglePlaceId($placeId: String!) {
    restaurants(where: { google_place_id: { _eq: $placeId } }, limit: 1) {
      uuid
    }
  }
`

const MATCH_BY_ADDRESS_PLACE_ID = `
  query MatchRestaurantByAddressPlaceId($placeId: String!) {
    restaurants(where: { address: { _contains: { place_id: $placeId } } }, limit: 1) {
      uuid
    }
  }
`

type MatchResult = { restaurants: Array<{ uuid: string }> }

/**
 * Resolve a Google place_id to a TastyPlates restaurant UUID.
 * Mirrors restaurants-v2/match-restaurant.ts lookup order.
 */
export async function resolveRestaurantUuidByPlaceId(placeId: string): Promise<string | null> {
  const trimmed = placeId.trim()
  if (!trimmed) return null

  try {
    const byColumn = await hasuraQuery<MatchResult>(MATCH_BY_GOOGLE_PLACE_ID, {
      placeId: trimmed,
    })
    const uuid = byColumn.data?.restaurants?.[0]?.uuid?.trim()
    if (uuid) return uuid
  } catch {
    // google_place_id column may be missing on older schemas
  }

  const byAddress = await hasuraQuery<MatchResult>(MATCH_BY_ADDRESS_PLACE_ID, {
    placeId: trimmed,
  })
  if (byAddress.errors?.length) {
    console.error('[resolveRestaurantByPlaceId]', byAddress.errors)
    return null
  }

  return byAddress.data?.restaurants?.[0]?.uuid?.trim() ?? null
}

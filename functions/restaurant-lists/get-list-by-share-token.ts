/**
 * GET /v1/restaurant-lists/get-list-by-share-token?token=<share_token>
 *
 * Resolves a private or public list via its opaque capability token.
 *
 * Security properties:
 * - Exact indexed lookup only — no search, enumeration, or prefix match.
 * - No authentication required ("unlisted playlist" pattern).
 * - share_token is NOT included in the response body (caller already has it).
 * - Wrong or missing token always returns a generic 404.
 *
 * Auth: None.
 */
import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { fetchPlaceCache, enrichItems, buildListResponse } from '../_lib/listEnrichment'
import type { RawList, RawListItem } from '../_lib/listEnrichment'

const GET_LIST_BY_SHARE_TOKEN = `
  query GetListByShareToken($shareToken: String!) {
    recommended_restaurant_lists(
      where: { share_token: { _eq: $shareToken }, is_active: { _eq: true } }
      limit: 1
    ) {
      id uuid slug title description is_public is_active
      share_token owner_id created_at updated_at
      owner { id displayName avatarUrl }
      items(order_by: { sort_order: asc }) {
        id list_id sort_order restaurant_uuid google_place_id
        restaurant_id city_location_id created_at
        restaurant {
          uuid slug title featured_image_url average_rating
          address listing_street cuisines
        }
      }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.query.token as string | undefined
    if (!token || token.length < 10) {
      // Generic 404 — don't hint that the parameter shape is wrong
      fail(res, 'List not found', 404)
      return
    }

    type Result = { recommended_restaurant_lists: RawList[] }
    const data = await hasuraAdmin<Result>(GET_LIST_BY_SHARE_TOKEN, { shareToken: token })
    const list = data.recommended_restaurant_lists?.[0]

    if (!list) {
      // Always 404, never 403 — prevents information leakage
      fail(res, 'List not found', 404)
      return
    }

    const googlePlaceIds = (list.items as RawListItem[])
      .filter((i) => i.google_place_id && !i.restaurant_uuid)
      .map((i) => i.google_place_id!)

    const placeCache = await fetchPlaceCache(googlePlaceIds)
    const enrichedItems = enrichItems(list.items as RawListItem[], placeCache)

    // callerId=null so share_token is always stripped from the response
    ok(res, { list: buildListResponse(list, enrichedItems, null) })
  } catch (error) {
    console.error('[restaurant-lists/get-list-by-share-token]', error)
    fail(res, 'Failed to fetch list', 500)
  }
}

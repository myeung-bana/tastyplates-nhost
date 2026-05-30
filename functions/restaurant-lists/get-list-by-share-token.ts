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
import { buildEnrichedListResponse } from '../_lib/listDetail'
import type { RawList } from '../_lib/listEnrichment'

const GET_LIST_BY_SHARE_TOKEN = `
  query GetListByShareToken($shareToken: String!) {
    recommended_restaurant_lists(
      where: { share_token: { _eq: $shareToken }, is_active: { _eq: true } }
      limit: 1
    ) {
      id uuid slug title description display_pic is_public is_active
      share_token owner_id created_at updated_at
      owner { id displayName avatarUrl }
      items: recommended_restaurant_list_items(order_by: { sort_order: asc }) {
        id list_id sort_order restaurant_uuid google_place_id created_at
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
      fail(res, 'List not found', 404)
      return
    }

    type Result = { recommended_restaurant_lists: RawList[] }
    const data = await hasuraAdmin<Result>(GET_LIST_BY_SHARE_TOKEN, { shareToken: token })
    const list = data.recommended_restaurant_lists?.[0]

    if (!list) {
      fail(res, 'List not found', 404)
      return
    }

    ok(res, { list: await buildEnrichedListResponse(list, null) })
  } catch (error) {
    console.error('[restaurant-lists/get-list-by-share-token]', error)
    fail(res, 'Failed to fetch list', 500)
  }
}

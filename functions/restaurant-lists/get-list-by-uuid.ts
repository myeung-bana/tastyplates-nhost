/**
 * GET /v1/restaurant-lists/get-list-by-uuid?uuid=<list_uuid>
 *
 * Same enriched payload as get-list-by-slug, keyed by list uuid (mobile detail route).
 *
 * Auth: Optional (required for private lists owned by the caller).
 */
import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import {
  assertListReadable,
  buildEnrichedListResponse,
  resolveOptionalCallerId,
} from '../_lib/listDetail'
import type { RawList } from '../_lib/listEnrichment'

const GET_LIST_BY_UUID = `
  query GetListByUuid($uuid: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid }, is_active: { _eq: true } }
      limit: 1
    ) {
      id uuid slug title description display_pic is_public is_active
      share_token owner_id created_at updated_at
      owner { id displayName avatarUrl }
      items: recommended_restaurant_list_items(order_by: { sort_order: asc }) {
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
    const uuid = req.query.uuid as string | undefined
    if (!uuid) {
      fail(res, 'uuid query param is required', 400)
      return
    }

    const callerId = await resolveOptionalCallerId(req, res)
    if (res.headersSent) return

    type Result = { recommended_restaurant_lists: RawList[] }
    const data = await hasuraAdmin<Result>(GET_LIST_BY_UUID, { uuid })
    const list = data.recommended_restaurant_lists?.[0]

    if (!list) {
      fail(res, 'List not found', 404)
      return
    }

    if (!assertListReadable(list, callerId)) {
      fail(res, 'List not found', 404)
      return
    }

    ok(res, { list: await buildEnrichedListResponse(list, callerId) })
  } catch (error) {
    console.error('[restaurant-lists/get-list-by-uuid]', error)
    fail(res, 'Failed to fetch list', 500)
  }
}

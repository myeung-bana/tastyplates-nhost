/**
 * GET /v1/restaurant-lists/get-list-by-slug?slug=<slug>
 *
 * Returns an enriched list by its slug.
 * - Public lists: accessible to anyone.
 * - Private lists: accessible to owner only (must include valid Bearer token).
 * - share_token is stripped from the response unless the caller is the owner.
 *
 * Auth: Optional (improves access for private/own lists).
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

const GET_LIST_BY_SLUG = `
  query GetListBySlug($slug: String!) {
    recommended_restaurant_lists(
      where: { slug: { _eq: $slug }, is_active: { _eq: true } }
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
    const slug = req.query.slug as string | undefined
    if (!slug) {
      fail(res, 'slug query param is required', 400)
      return
    }

    const callerId = await resolveOptionalCallerId(req, res)
    if (res.headersSent) return

    type Result = { recommended_restaurant_lists: RawList[] }
    const data = await hasuraAdmin<Result>(GET_LIST_BY_SLUG, { slug })
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
    console.error('[restaurant-lists/get-list-by-slug]', error)
    fail(res, 'Failed to fetch list', 500)
  }
}

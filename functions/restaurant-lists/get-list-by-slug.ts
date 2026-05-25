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
import { getUserId } from '../_lib/auth'
import { requireAuth } from '../_lib/auth'
import { fetchPlaceCache, enrichItems, buildListResponse } from '../_lib/listEnrichment'
import type { RawList, RawListItem } from '../_lib/listEnrichment'

const GET_LIST_BY_SLUG = `
  query GetListBySlug($slug: String!) {
    recommended_restaurant_lists(
      where: { slug: { _eq: $slug }, is_active: { _eq: true } }
      limit: 1
    ) {
      id uuid slug title description is_public is_active
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
    const slug = req.query.slug as string | undefined
    if (!slug) {
      fail(res, 'slug query param is required', 400)
      return
    }

    // Auth is optional — try to get caller identity without rejecting on failure
    let callerId: string | null = null
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = await requireAuth(req, res)
        if (payload) callerId = getUserId(payload)
        // If requireAuth already sent a 401, stop here
        if (!payload && res.headersSent) return
      } catch {
        // Ignore auth errors for optional auth endpoints
      }
    }

    type Result = { recommended_restaurant_lists: RawList[] }
    const data = await hasuraAdmin<Result>(GET_LIST_BY_SLUG, { slug })
    const list = data.recommended_restaurant_lists?.[0]

    if (!list) {
      fail(res, 'List not found', 404)
      return
    }

    // Private list: only owner can see it
    if (!list.is_public && callerId !== list.owner_id) {
      fail(res, 'List not found', 404)
      return
    }

    const googlePlaceIds = (list.items as RawListItem[])
      .filter((i) => i.google_place_id && !i.restaurant_uuid)
      .map((i) => i.google_place_id!)

    const placeCache = await fetchPlaceCache(googlePlaceIds)
    const enrichedItems = enrichItems(list.items as RawListItem[], placeCache)

    ok(res, { list: buildListResponse(list, enrichedItems, callerId) })
  } catch (error) {
    console.error('[restaurant-lists/get-list-by-slug]', error)
    fail(res, 'Failed to fetch list', 500)
  }
}

/**
 * Shared list detail load + enrich (slug, uuid, share-token endpoints).
 *
 * Loads items by `list_id = list.uuid` when the parent array relationship returns
 * no rows (common when FK metadata still points at numeric `id`).
 */
import type { Request, Response } from 'express'
import { getUserId, requireAuth } from './auth'
import { hasuraAdmin } from './hasura'
import {
  buildListResponse,
  collectGooglePlaceIds,
  enrichItems,
  fetchPlaceCacheSafe,
  hydrateItemRestaurants,
  type RawList,
  type RawListItem,
} from './listEnrichment'

const LIST_ITEMS_BY_LIST_UUID = `
  query ListItemsByListUuid($listUuid: uuid!) {
    recommended_restaurant_list_items(
      where: { list_id: { _eq: $listUuid } }
      order_by: { sort_order: asc }
    ) {
      id list_id sort_order restaurant_uuid google_place_id created_at
      restaurant {
        uuid slug title featured_image_url average_rating
        address listing_street cuisines
      }
    }
  }
`

/** Optional Bearer — returns caller user id or null without failing the request. */
export async function resolveOptionalCallerId(
  req: Request,
  res: Response,
): Promise<string | null> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    const payload = await requireAuth(req, res)
    if (!payload) {
      if (res.headersSent) return null
      return null
    }
    return getUserId(payload)
  } catch {
    return null
  }
}

export function assertListReadable(list: RawList, callerId: string | null): boolean {
  if (list.is_public) return true
  return callerId !== null && callerId === list.owner_id
}

async function fetchItemsByListUuid(listUuid: string): Promise<RawListItem[]> {
  type R = { recommended_restaurant_list_items: RawListItem[] }
  const data = await hasuraAdmin<R>(LIST_ITEMS_BY_LIST_UUID, { listUuid })
  return data.recommended_restaurant_list_items ?? []
}

/** Resolve items (relationship or direct query) and return enriched API payload. */
export async function buildEnrichedListResponse(
  list: RawList,
  callerId: string | null,
): Promise<Record<string, unknown>> {
  let items = (list.items ?? []) as RawListItem[]
  if (items.length === 0 && list.uuid) {
    items = await fetchItemsByListUuid(list.uuid)
  }

  items = await hydrateItemRestaurants(items)
  const placeCache = await fetchPlaceCacheSafe(collectGooglePlaceIds(items))
  const enrichedItems = enrichItems(items, placeCache)
  return buildListResponse({ ...list, items }, enrichedItems, callerId)
}

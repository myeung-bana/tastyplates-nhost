/**
 * Shared enrichment logic for restaurant list read APIs.
 *
 * Used by get-list-by-slug, get-list-by-uuid, get-list-by-share-token, and get-public-lists.
 *
 * - TP items (restaurant_uuid): joined from `restaurants` table (relationship or batch fallback).
 * - Google rows: batch-loaded from `google_place_cache` when the join is missing or for Google-only items.
 * - share_token is stripped from the response unless the caller is the owner.
 */
import { hasuraAdmin } from './hasura'

// ── Raw shapes from Hasura ───────────────────────────────────────────────────

export interface RawListItem {
  id: number
  list_id: number | string
  sort_order: number
  restaurant_uuid: string | null
  google_place_id: string | null
  restaurant_id: number | null
  city_location_id: number | null
  created_at: string
  restaurant: {
    uuid: string
    slug: string
    title: string
    featured_image_url: string | null
    average_rating: number | null
    address: unknown
    cuisines: unknown
    listing_street: string | null
  } | null
}

export interface RawList {
  id: number
  uuid: string
  slug: string
  title: string
  description: string | null
  display_pic?: string | null
  is_public: boolean
  is_active: boolean
  share_token: string | null
  owner_id: string | null
  created_at: string
  updated_at: string
  owner: {
    id: string
    displayName: string | null
    avatarUrl: string | null
  } | null
  items: RawListItem[]
}

// ── google_place_cache enrichment ────────────────────────────────────────────

interface PlaceCache {
  google_place_id: string
  name: string
  formatted_address: string | null
  primary_photo_url: string | null
  google_rating: number | null
  tastyplates_restaurant_uuid: string | null
  tastyplates_restaurant_slug: string | null
}

type RestaurantRow = NonNullable<RawListItem['restaurant']>

const BATCH_PLACE_CACHE = `
  query BatchPlaceCache($placeIds: [String!]!) {
    google_place_cache(where: { google_place_id: { _in: $placeIds } }) {
      google_place_id name formatted_address primary_photo_url google_rating
      tastyplates_restaurant_uuid tastyplates_restaurant_slug
    }
  }
`

const BATCH_RESTAURANTS_BY_UUID = `
  query BatchRestaurantsByUuid($uuids: [uuid!]!) {
    restaurants(where: { uuid: { _in: $uuids } }) {
      uuid slug title featured_image_url average_rating
      address listing_street cuisines
    }
  }
`

/** All non-empty Google place ids on the list (including TP-matched rows). */
export function collectGooglePlaceIds(items: RawListItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    const pid = item.google_place_id?.trim()
    if (pid) ids.add(pid)
  }
  return [...ids]
}

export async function fetchPlaceCache(placeIds: string[]): Promise<Map<string, PlaceCache>> {
  if (placeIds.length === 0) return new Map()
  type R = { google_place_cache: PlaceCache[] }
  const data = await hasuraAdmin<R>(BATCH_PLACE_CACHE, { placeIds })
  return new Map((data.google_place_cache ?? []).map((p) => [p.google_place_id, p]))
}

/** Tolerates untracked `google_place_cache` — returns empty map instead of failing the list. */
export async function fetchPlaceCacheSafe(placeIds: string[]): Promise<Map<string, PlaceCache>> {
  try {
    return await fetchPlaceCache(placeIds)
  } catch (error) {
    console.warn('[listEnrichment] google_place_cache lookup failed:', error)
    return new Map()
  }
}

/** Batch-load `restaurants` when the nested Hasura relationship did not resolve. */
export async function hydrateItemRestaurants(items: RawListItem[]): Promise<RawListItem[]> {
  const missingUuids = [
    ...new Set(
      items
        .filter((i) => i.restaurant_uuid && !i.restaurant)
        .map((i) => i.restaurant_uuid!),
    ),
  ]
  if (missingUuids.length === 0) return items

  type R = { restaurants: RestaurantRow[] }
  let rows: RestaurantRow[] = []
  try {
    const data = await hasuraAdmin<R>(BATCH_RESTAURANTS_BY_UUID, { uuids: missingUuids })
    rows = data.restaurants ?? []
  } catch (error) {
    console.warn('[listEnrichment] restaurants batch lookup failed:', error)
    return items
  }

  const byUuid = new Map(rows.map((r) => [r.uuid, r]))
  return items.map((item) => {
    if (item.restaurant || !item.restaurant_uuid) return item
    const row = byUuid.get(item.restaurant_uuid)
    return row ? { ...item, restaurant: row } : item
  })
}

// ── Public enriched item shape ───────────────────────────────────────────────

export interface EnrichedItem {
  id: number
  sort_order: number
  restaurant_uuid: string | null
  google_place_id: string | null
  name: string | null
  slug: string | null
  image_url: string | null
  address: string | null
  rating: number | null
}

function restaurantAddress(r: RestaurantRow): string | null {
  if (typeof r.listing_street === 'string' && r.listing_street.trim()) {
    return r.listing_street.trim()
  }
  if (typeof r.address === 'object' && r.address !== null) {
    const formatted = (r.address as Record<string, string>).formatted_address
    if (typeof formatted === 'string' && formatted.trim()) return formatted.trim()
  }
  return null
}

function fromRestaurant(item: RawListItem, r: RestaurantRow): EnrichedItem {
  return {
    id: item.id,
    sort_order: item.sort_order,
    restaurant_uuid: item.restaurant_uuid,
    google_place_id: item.google_place_id,
    name: r.title,
    slug: r.slug,
    image_url: r.featured_image_url,
    address: restaurantAddress(r),
    rating: r.average_rating,
  }
}

function fromPlaceCache(item: RawListItem, cached: PlaceCache): EnrichedItem {
  return {
    id: item.id,
    sort_order: item.sort_order,
    restaurant_uuid: item.restaurant_uuid ?? cached.tastyplates_restaurant_uuid,
    google_place_id: item.google_place_id,
    name: cached.name,
    slug: cached.tastyplates_restaurant_slug,
    image_url: cached.primary_photo_url,
    address: cached.formatted_address,
    rating: cached.google_rating,
  }
}

export function enrichItems(items: RawListItem[], placeCache: Map<string, PlaceCache>): EnrichedItem[] {
  return items.map((item) => {
    if (item.restaurant) {
      return fromRestaurant(item, item.restaurant)
    }

    const cached = item.google_place_id ? placeCache.get(item.google_place_id) ?? null : null
    if (cached) {
      return fromPlaceCache(item, cached)
    }

    return {
      id: item.id,
      sort_order: item.sort_order,
      restaurant_uuid: item.restaurant_uuid,
      google_place_id: item.google_place_id,
      name: null,
      slug: null,
      image_url: null,
      address: null,
      rating: null,
    }
  })
}

// ── Strip share_token for non-owners ────────────────────────────────────────

export function buildListResponse(
  list: RawList,
  enrichedItems: EnrichedItem[],
  callerId: string | null,
): Record<string, unknown> {
  const isOwner = callerId !== null && callerId === list.owner_id
  const displayPic = list.display_pic?.trim() || null
  const firstItemImage = enrichedItems[0]?.image_url?.trim() || null
  return {
    id: list.id,
    uuid: list.uuid,
    slug: list.slug,
    title: list.title,
    description: list.description,
    display_pic: displayPic,
    cover_image_url: displayPic || firstItemImage,
    is_public: list.is_public,
    is_active: list.is_active,
    ...(isOwner ? { share_token: list.share_token } : {}),
    owner_id: list.owner_id,
    owner: list.owner ? { displayName: list.owner.displayName, avatarUrl: list.owner.avatarUrl } : null,
    created_at: list.created_at,
    updated_at: list.updated_at,
    items: enrichedItems,
  }
}

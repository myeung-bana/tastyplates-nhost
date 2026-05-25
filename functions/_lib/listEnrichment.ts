/**
 * Shared enrichment logic for restaurant list read APIs.
 *
 * Used by get-list-by-slug, get-list-by-share-token, and get-public-lists.
 *
 * - TP items (restaurant_uuid): joined from `restaurants` table.
 * - Google-only items (google_place_id, no restaurant_uuid): batch-loaded
 *   from `google_place_cache` for name, address, photo, and rating.
 * - share_token is stripped from the response unless the caller is the owner.
 */
import { hasuraAdmin } from './hasura'

// ── Raw shapes from Hasura ───────────────────────────────────────────────────

export interface RawListItem {
  id: number
  list_id: number
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

const BATCH_PLACE_CACHE = `
  query BatchPlaceCache($placeIds: [String!]!) {
    google_place_cache(where: { google_place_id: { _in: $placeIds } }) {
      google_place_id name formatted_address primary_photo_url google_rating
      tastyplates_restaurant_uuid tastyplates_restaurant_slug
    }
  }
`

export async function fetchPlaceCache(placeIds: string[]): Promise<Map<string, PlaceCache>> {
  if (placeIds.length === 0) return new Map()
  type R = { google_place_cache: PlaceCache[] }
  const data = await hasuraAdmin<R>(BATCH_PLACE_CACHE, { placeIds })
  return new Map((data.google_place_cache ?? []).map((p) => [p.google_place_id, p]))
}

// ── Public enriched item shape ───────────────────────────────────────────────

export interface EnrichedItem {
  id: number
  sort_order: number
  restaurant_uuid: string | null
  google_place_id: string | null
  // Resolved display fields (from TP or Google cache)
  name: string | null
  slug: string | null
  image_url: string | null
  address: string | null
  rating: number | null
}

export function enrichItems(items: RawListItem[], placeCache: Map<string, PlaceCache>): EnrichedItem[] {
  return items.map((item) => {
    if (item.restaurant) {
      const r = item.restaurant
      const addr =
        typeof r.listing_street === 'string'
          ? r.listing_street
          : typeof r.address === 'object' && r.address !== null
            ? ((r.address as Record<string, string>).formatted_address ?? null)
            : null
      return {
        id: item.id,
        sort_order: item.sort_order,
        restaurant_uuid: item.restaurant_uuid,
        google_place_id: item.google_place_id,
        name: r.title,
        slug: r.slug,
        image_url: r.featured_image_url,
        address: addr,
        rating: r.average_rating,
      }
    }

    const cached = item.google_place_id ? placeCache.get(item.google_place_id) ?? null : null
    return {
      id: item.id,
      sort_order: item.sort_order,
      restaurant_uuid: item.restaurant_uuid,
      google_place_id: item.google_place_id,
      name: cached?.name ?? null,
      slug: cached?.tastyplates_restaurant_slug ?? null,
      image_url: cached?.primary_photo_url ?? null,
      address: cached?.formatted_address ?? null,
      rating: cached?.google_rating ?? null,
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
  return {
    id: list.id,
    uuid: list.uuid,
    slug: list.slug,
    title: list.title,
    description: list.description,
    is_public: list.is_public,
    is_active: list.is_active,
    // share_token only returned to the owner
    ...(isOwner ? { share_token: list.share_token } : {}),
    owner_id: list.owner_id,
    owner: list.owner ? { displayName: list.owner.displayName, avatarUrl: list.owner.avatarUrl } : null,
    created_at: list.created_at,
    updated_at: list.updated_at,
    items: enrichedItems,
  }
}

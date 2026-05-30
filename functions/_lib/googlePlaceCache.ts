/**
 * Upsert rows into `google_place_cache` so list read APIs can resolve Google-only items.
 */
import { hasuraAdmin } from './hasura'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface UpsertPlaceCacheInput {
  google_place_id: string
  name: string
  formatted_address?: string | null
  latitude?: number | null
  longitude?: number | null
  primary_photo_url?: string | null
  google_rating?: number | null
  user_ratings_total?: number | null
  tastyplates_restaurant_uuid?: string | null
  tastyplates_restaurant_slug?: string | null
}

const UPSERT_PLACE_CACHE = `
  mutation UpsertGooglePlaceCache(
    $googlePlaceId: String!
    $name: String!
    $formattedAddress: String
    $latitude: numeric
    $longitude: numeric
    $primaryPhotoUrl: String
    $googleRating: numeric
    $userRatingsTotal: Int
    $tpUuid: uuid
    $tpSlug: String
    $fetchedAt: timestamptz!
    $expiresAt: timestamptz!
  ) {
    insert_google_place_cache_one(
      object: {
        google_place_id: $googlePlaceId
        name: $name
        formatted_address: $formattedAddress
        latitude: $latitude
        longitude: $longitude
        primary_photo_url: $primaryPhotoUrl
        google_rating: $googleRating
        user_ratings_total: $userRatingsTotal
        tastyplates_restaurant_uuid: $tpUuid
        tastyplates_restaurant_slug: $tpSlug
        fetched_at: $fetchedAt
        expires_at: $expiresAt
      }
      on_conflict: {
        constraint: google_place_cache_pkey
        update_columns: [
          name
          formatted_address
          latitude
          longitude
          primary_photo_url
          google_rating
          user_ratings_total
          tastyplates_restaurant_uuid
          tastyplates_restaurant_slug
          fetched_at
          expires_at
        ]
      }
    ) {
      google_place_id
    }
  }
`

export async function upsertGooglePlaceCache(input: UpsertPlaceCacheInput): Promise<void> {
  const placeId = input.google_place_id.trim()
  const name = input.name.trim()
  if (!placeId || !name) return

  const now = new Date()
  const fetchedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS).toISOString()

  await hasuraAdmin(UPSERT_PLACE_CACHE, {
    googlePlaceId: placeId,
    name,
    formattedAddress: input.formatted_address?.trim() || null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    primaryPhotoUrl: input.primary_photo_url?.trim() || null,
    googleRating: input.google_rating ?? null,
    userRatingsTotal: input.user_ratings_total ?? null,
    tpUuid: input.tastyplates_restaurant_uuid ?? null,
    tpSlug: input.tastyplates_restaurant_slug?.trim() || null,
    fetchedAt,
    expiresAt,
  })
}

/** Never fails add-item — logs and continues if cache table is missing or untracked. */
export async function upsertGooglePlaceCacheSafe(input: UpsertPlaceCacheInput): Promise<void> {
  try {
    await upsertGooglePlaceCache(input)
  } catch (error) {
    console.warn('[googlePlaceCache] upsert failed:', error)
  }
}

import type { ExternalDataSource, NormalizedExternalData, RestaurantExternalDataRow } from './restaurantExternalDataTypes'
import { hasuraAdmin, hasuraQuery } from './hasura'

const GET_BY_RESTAURANT = `
  query GetRestaurantExternalData($restaurantUuid: uuid!) {
    restaurant_external_data(
      where: { restaurant_uuid: { _eq: $restaurantUuid } }
      order_by: { source: asc }
    ) {
      id
      restaurant_uuid
      source
      sync_status
      apify_run_id
      apify_dataset_id
      external_rating
      external_review_count
      price_level
      cuisine_tags
      popular_dishes
      opening_hours
      photo_urls
      raw_payload
      published_fields
      error_message
      last_synced_at
      created_at
      updated_at
    }
  }
`

const GET_BY_RUN_ID = `
  query GetExternalDataByRunId($runId: String!) {
    restaurant_external_data(where: { apify_run_id: { _eq: $runId } }, limit: 1) {
      id
      restaurant_uuid
      source
      sync_status
    }
  }
`

const UPSERT_RUNNING = `
  mutation UpsertExternalDataRunning(
    $restaurantUuid: uuid!
    $source: String!
    $syncStatus: String!
    $apifyRunId: String
  ) {
    insert_restaurant_external_data_one(
      object: {
        restaurant_uuid: $restaurantUuid
        source: $source
        sync_status: $syncStatus
        apify_run_id: $apifyRunId
        error_message: null
      }
      on_conflict: {
        constraint: restaurant_external_data_restaurant_uuid_source_key
        update_columns: [sync_status, apify_run_id, error_message, updated_at]
      }
    ) {
      id
      restaurant_uuid
      source
      sync_status
      apify_run_id
      updated_at
    }
  }
`

const UPDATE_SUCCEEDED = `
  mutation UpdateExternalDataSucceeded(
    $id: uuid!
    $apifyDatasetId: String
    $externalRating: numeric
    $externalReviewCount: Int
    $priceLevel: String
    $cuisineTags: jsonb
    $popularDishes: jsonb
    $openingHours: jsonb
    $photoUrls: jsonb
    $rawPayload: jsonb!
    $lastSyncedAt: timestamptz!
  ) {
    update_restaurant_external_data_by_pk(
      pk_columns: { id: $id }
      _set: {
        sync_status: "succeeded"
        apify_dataset_id: $apifyDatasetId
        external_rating: $externalRating
        external_review_count: $externalReviewCount
        price_level: $priceLevel
        cuisine_tags: $cuisineTags
        popular_dishes: $popularDishes
        opening_hours: $openingHours
        photo_urls: $photoUrls
        raw_payload: $rawPayload
        error_message: null
        last_synced_at: $lastSyncedAt
      }
    ) {
      id
      sync_status
      last_synced_at
    }
  }
`

const UPDATE_FAILED = `
  mutation UpdateExternalDataFailed($id: uuid!, $errorMessage: String!) {
    update_restaurant_external_data_by_pk(
      pk_columns: { id: $id }
      _set: {
        sync_status: "failed"
        error_message: $errorMessage
        last_synced_at: "now()"
      }
    ) {
      id
      sync_status
      error_message
    }
  }
`

const GET_RESTAURANT_FOR_SCRAPE = `
  query GetRestaurantForScrape($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      uuid
      title
      listing_street
      google_place_id
      latitude
      longitude
      address
    }
  }
`

export async function listExternalDataByRestaurant(
  restaurantUuid: string,
): Promise<RestaurantExternalDataRow[]> {
  type Result = { restaurant_external_data: RestaurantExternalDataRow[] }
  const result = await hasuraQuery<Result>(GET_BY_RESTAURANT, { restaurantUuid })
  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join(', '))
  }
  return result.data?.restaurant_external_data ?? []
}

export async function findExternalDataByRunId(runId: string): Promise<{
  id: string
  restaurant_uuid: string
  source: ExternalDataSource
  sync_status: string
} | null> {
  type Result = {
    restaurant_external_data: Array<{
      id: string
      restaurant_uuid: string
      source: ExternalDataSource
      sync_status: string
    }>
  }
  const result = await hasuraQuery<Result>(GET_BY_RUN_ID, { runId })
  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join(', '))
  }
  return result.data?.restaurant_external_data?.[0] ?? null
}

export async function upsertExternalDataRunning(input: {
  restaurantUuid: string
  source: ExternalDataSource
  apifyRunId: string | null
}): Promise<RestaurantExternalDataRow> {
  type Result = {
    insert_restaurant_external_data_one: RestaurantExternalDataRow
  }
  const data = await hasuraAdmin<Result>(UPSERT_RUNNING, {
    restaurantUuid: input.restaurantUuid,
    source: input.source,
    syncStatus: 'running',
    apifyRunId: input.apifyRunId,
  })
  return data.insert_restaurant_external_data_one
}

export async function markExternalDataSucceeded(
  id: string,
  normalized: NormalizedExternalData,
  apifyDatasetId: string | null,
): Promise<void> {
  await hasuraAdmin(UPDATE_SUCCEEDED, {
    id,
    apifyDatasetId,
    externalRating: normalized.external_rating,
    externalReviewCount: normalized.external_review_count,
    priceLevel: normalized.price_level,
    cuisineTags: normalized.cuisine_tags,
    popularDishes: normalized.popular_dishes,
    openingHours: normalized.opening_hours,
    photoUrls: normalized.photo_urls,
    rawPayload: normalized.raw_payload,
    lastSyncedAt: new Date().toISOString(),
  })
}

export async function markExternalDataFailed(id: string, errorMessage: string): Promise<void> {
  await hasuraAdmin(UPDATE_FAILED, { id, errorMessage: errorMessage.slice(0, 2000) })
}

export interface RestaurantScrapeContext {
  uuid: string
  title: string
  listing_street: string | null
  google_place_id: string | null
  latitude: number | null
  longitude: number | null
  address: Record<string, unknown> | null
}

export async function loadRestaurantForScrape(uuid: string): Promise<RestaurantScrapeContext | null> {
  type Result = { restaurants: RestaurantScrapeContext[] }
  const result = await hasuraQuery<Result>(GET_RESTAURANT_FOR_SCRAPE, { uuid })
  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join(', '))
  }
  return result.data?.restaurants?.[0] ?? null
}

export function resolveGooglePlaceId(restaurant: RestaurantScrapeContext): string | null {
  const direct = restaurant.google_place_id?.trim()
  if (direct) return direct

  const fromAddress = restaurant.address?.place_id
  if (typeof fromAddress === 'string' && fromAddress.trim()) {
    return fromAddress.trim()
  }
  return null
}

export function buildScrapeSearchQuery(restaurant: RestaurantScrapeContext): string {
  const parts = [restaurant.title?.trim(), restaurant.listing_street?.trim()].filter(Boolean)
  if (parts.length > 0) return parts.join(', ')

  const addr = restaurant.address
  if (addr && typeof addr === 'object') {
    const street = typeof addr.street_address === 'string' ? addr.street_address : ''
    const city = typeof addr.city === 'string' ? addr.city : ''
    const joined = [restaurant.title, street, city].filter(Boolean).join(', ')
    if (joined.trim()) return joined.trim()
  }

  return restaurant.title?.trim() || 'restaurant'
}

export type ExternalDataSource = 'google_maps' | 'yelp' | 'tripadvisor'

export type ExternalSyncStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RestaurantExternalDataRow {
  id: string
  restaurant_uuid: string
  source: ExternalDataSource
  sync_status: ExternalSyncStatus
  apify_run_id: string | null
  apify_dataset_id: string | null
  external_rating: number | null
  external_review_count: number | null
  price_level: string | null
  cuisine_tags: unknown
  popular_dishes: unknown
  opening_hours: unknown
  photo_urls: unknown
  raw_payload: unknown
  published_fields: unknown
  error_message: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export interface NormalizedExternalData {
  external_rating: number | null
  external_review_count: number | null
  price_level: string | null
  cuisine_tags: string[] | null
  popular_dishes: string[] | null
  opening_hours: unknown
  photo_urls: string[] | null
  raw_payload: Record<string, unknown>
}

export const EXTERNAL_DATA_SOURCES: ExternalDataSource[] = ['google_maps', 'yelp', 'tripadvisor']

export function isExternalDataSource(value: string): value is ExternalDataSource {
  return (EXTERNAL_DATA_SOURCES as string[]).includes(value)
}

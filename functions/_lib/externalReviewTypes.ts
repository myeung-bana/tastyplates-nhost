export const EXTERNAL_REVIEW_DEDUP_CONSTRAINT = 'ext_reviews_platform_review_id_uniq'

export const EXTERNAL_REVIEW_PLATFORMS = ['google_maps', 'yelp', 'tripadvisor'] as const

export type ExternalReviewPlatform = (typeof EXTERNAL_REVIEW_PLATFORMS)[number]

export type ExternalReviewSentiment = 'positive' | 'neutral' | 'negative'

export interface ExternalReviewRow {
  id: string
  restaurant_uuid: string
  source_platform: ExternalReviewPlatform
  source_review_id: string
  source_url: string | null
  source_author_name: string | null
  source_author_id: string | null
  reviewed_at: string | null
  rating: number
  body: string | null
  language: string | null
  palates: string[]
  author_palates: string[]
  sentiment: ExternalReviewSentiment | null
  is_flagged: boolean
  flagged_reason: string | null
  ingested_at: string
  ingest_batch_id: string | null
}

export interface ExternalReviewSummaryRow {
  restaurant_uuid: string
  total_count: number
  average_rating: number | null
  platform_breakdown: Record<string, { count: number; avg: number }>
  language_breakdown: Record<string, number>
  palate_breakdown: Record<string, number>
  sentiment_breakdown: Record<string, number>
  last_updated_at: string
}

export interface IngestReviewItem {
  review_id: string
  place_id: string
  author_name?: string
  author_id?: string
  rating: number
  text?: string
  published_at?: string
  url?: string
}

export interface IngestPayload {
  apify_run_id: string
  platform: string
  items: IngestReviewItem[]
}

export interface IngestResult {
  ingested: number
  skipped: number
  failed: number
  affected_restaurant_uuids: string[]
}

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Map Apify / PRD short names to DB enum values. */
export function normalizeSourcePlatform(value: string): ExternalReviewPlatform | null {
  const v = value.trim().toLowerCase()
  if (v === 'google' || v === 'google_maps') return 'google_maps'
  if (v === 'yelp') return 'yelp'
  if (v === 'tripadvisor') return 'tripadvisor'
  return null
}

export function clampRating(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1 || n > 5) return null
  return Number(n.toFixed(1))
}

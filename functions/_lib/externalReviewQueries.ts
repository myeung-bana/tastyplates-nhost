import { hasuraAdmin, hasuraQuery } from './hasura'
import {
  EXTERNAL_REVIEW_DEDUP_CONSTRAINT,
  type ExternalReviewPlatform,
  type ExternalReviewRow,
  type ExternalReviewSummaryRow,
} from './externalReviewTypes'

const UPSERT_EXTERNAL_REVIEW = `
  mutation UpsertExternalReview($object: restaurant_external_reviews_insert_input!) {
    insert_restaurant_external_reviews_one(
      object: $object
      on_conflict: {
        constraint: ${EXTERNAL_REVIEW_DEDUP_CONSTRAINT}
        update_columns: [
          restaurant_uuid
          rating
          body
          language
          palates
          sentiment
          reviewed_at
          source_url
          source_author_name
          source_author_id
          ingest_batch_id
        ]
      }
    ) {
      id
      restaurant_uuid
    }
  }
`

const LIST_EXTERNAL_REVIEWS = `
  query ListExternalReviews(
    $where: restaurant_external_reviews_bool_exp!
    $limit: Int!
    $offset: Int!
  ) {
    restaurant_external_reviews(
      where: $where
      order_by: { ingested_at: desc }
      limit: $limit
      offset: $offset
    ) {
      id
      restaurant_uuid
      source_platform
      source_review_id
      source_url
      source_author_name
      source_author_id
      reviewed_at
      rating
      body
      language
      palates
      sentiment
      is_flagged
      flagged_reason
      ingested_at
      ingest_batch_id
    }
    restaurant_external_reviews_aggregate(where: $where) {
      aggregate { count }
    }
  }
`

const GET_EXTERNAL_REVIEW_BY_ID = `
  query GetExternalReviewById($id: uuid!) {
    restaurant_external_reviews_by_pk(id: $id) {
      id
      restaurant_uuid
      source_platform
      source_review_id
      source_url
      source_author_name
      source_author_id
      reviewed_at
      rating
      body
      language
      palates
      sentiment
      is_flagged
      flagged_reason
      ingested_at
      ingest_batch_id
    }
  }
`

const FLAG_EXTERNAL_REVIEW = `
  mutation FlagExternalReview(
    $id: uuid!
    $is_flagged: Boolean!
    $flagged_reason: String
  ) {
    update_restaurant_external_reviews_by_pk(
      pk_columns: { id: $id }
      _set: { is_flagged: $is_flagged, flagged_reason: $flagged_reason }
    ) {
      id
      restaurant_uuid
      is_flagged
      flagged_reason
    }
  }
`

export interface UpsertExternalReviewInput {
  restaurant_uuid: string
  source_platform: ExternalReviewPlatform
  source_review_id: string
  rating: number
  body?: string | null
  language?: string | null
  palates?: string[]
  sentiment?: string | null
  reviewed_at?: string | null
  source_url?: string | null
  source_author_name?: string | null
  source_author_id?: string | null
  ingest_batch_id?: string | null
}

export async function upsertExternalReview(input: UpsertExternalReviewInput): Promise<string | null> {
  const data = await hasuraAdmin<{
    insert_restaurant_external_reviews_one: { id: string; restaurant_uuid: string } | null
  }>(UPSERT_EXTERNAL_REVIEW, {
    object: {
      restaurant_uuid: input.restaurant_uuid,
      source_platform: input.source_platform,
      source_review_id: input.source_review_id,
      rating: input.rating,
      body: input.body ?? null,
      language: input.language ?? null,
      palates: input.palates ?? [],
      sentiment: input.sentiment ?? null,
      reviewed_at: input.reviewed_at ?? null,
      source_url: input.source_url ?? null,
      source_author_name: input.source_author_name ?? null,
      source_author_id: input.source_author_id ?? null,
      ingest_batch_id: input.ingest_batch_id ?? null,
    },
  })

  return data.insert_restaurant_external_reviews_one?.restaurant_uuid ?? null
}

export async function listExternalReviews(params: {
  where: Record<string, unknown>
  limit: number
  offset: number
}): Promise<{ reviews: ExternalReviewRow[]; total: number }> {
  const data = await hasuraAdmin<{
    restaurant_external_reviews: ExternalReviewRow[]
    restaurant_external_reviews_aggregate: { aggregate: { count: number } | null }
  }>(LIST_EXTERNAL_REVIEWS, params)

  return {
    reviews: data.restaurant_external_reviews ?? [],
    total: data.restaurant_external_reviews_aggregate?.aggregate?.count ?? 0,
  }
}

export async function getExternalReviewById(id: string): Promise<ExternalReviewRow | null> {
  const data = await hasuraAdmin<{
    restaurant_external_reviews_by_pk: ExternalReviewRow | null
  }>(GET_EXTERNAL_REVIEW_BY_ID, { id })
  return data.restaurant_external_reviews_by_pk ?? null
}

export async function flagExternalReview(
  id: string,
  isFlagged: boolean,
  flaggedReason?: string | null,
): Promise<{ id: string; restaurant_uuid: string } | null> {
  const data = await hasuraAdmin<{
    update_restaurant_external_reviews_by_pk: {
      id: string
      restaurant_uuid: string
      is_flagged: boolean
      flagged_reason: string | null
    } | null
  }>(FLAG_EXTERNAL_REVIEW, {
    id,
    is_flagged: isFlagged,
    flagged_reason: flaggedReason ?? null,
  })

  const row = data.update_restaurant_external_reviews_by_pk
  if (!row) return null
  return { id: row.id, restaurant_uuid: row.restaurant_uuid }
}

export function buildExternalReviewWhere(params: URLSearchParams): Record<string, unknown> {
  const where: Record<string, unknown> = {}

  const restaurantUuid = params.get('restaurant_uuid')?.trim()
  if (restaurantUuid) where.restaurant_uuid = { _eq: restaurantUuid }

  const id = params.get('id')?.trim()
  if (id) where.id = { _eq: id }

  const platform = params.get('platform')?.trim()
  if (platform) where.source_platform = { _eq: platform }

  const language = params.get('language')?.trim()
  if (language) where.language = { _eq: language }

  const palate = params.get('palate')?.trim()
  if (palate) where.palates = { _contains: [palate.toLowerCase()] }

  const sentiment = params.get('sentiment')?.trim()
  if (sentiment) where.sentiment = { _eq: sentiment }

  const isFlagged = params.get('is_flagged')
  if (isFlagged === 'true' || isFlagged === 'false') {
    where.is_flagged = { _eq: isFlagged === 'true' }
  }

  return where
}

export async function getExternalReviewSummary(
  restaurantUuid: string,
): Promise<ExternalReviewSummaryRow | null> {
  const result = await hasuraQuery<{
    restaurant_external_review_summary_by_pk: ExternalReviewSummaryRow | null
  }>(
    `query GetExternalReviewSummary($uuid: uuid!) {
      restaurant_external_review_summary_by_pk(restaurant_uuid: $uuid) {
        restaurant_uuid total_count average_rating
        platform_breakdown language_breakdown palate_breakdown sentiment_breakdown
        last_updated_at
      }
    }`,
    { uuid: restaurantUuid },
  )

  if (result.errors?.length) {
    console.error('[getExternalReviewSummary]', result.errors)
    return null
  }

  return result.data?.restaurant_external_review_summary_by_pk ?? null
}

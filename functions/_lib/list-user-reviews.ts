import { hasuraQuery } from './hasura'
import {
  isValidUuid,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
  safeEnrichReviewRows,
} from './review-enrichment'

const REVIEW_ROW_FIELDS = `
  id title content rating images palates hashtags likes_count replies_count status
  created_at published_at author_id restaurant_uuid
`

const REVIEW_ROW_FIELDS_EXTENDED = `
  id title content rating images palates hashtags likes_count replies_count status
  created_at updated_at published_at author_id restaurant_uuid
`

const REVIEW_ROW_SUMMARY = `
  id title content rating status
  created_at updated_at published_at author_id restaurant_uuid
  likes_count replies_count
`

const REVIEW_ROW_SUMMARY_FALLBACK = `
  id title content rating status
  created_at published_at author_id restaurant_uuid
  likes_count replies_count
`

function pickReviewFields(summary: boolean, extended: boolean): string {
  if (summary) return extended ? REVIEW_ROW_SUMMARY : REVIEW_ROW_SUMMARY_FALLBACK
  return extended ? REVIEW_ROW_FIELDS_EXTENDED : REVIEW_ROW_FIELDS
}

function buildAllUserReviewsQuery(fields: string, nestedAuthor: string): string {
  return `
  query GetUserReviews($authorId: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      ${fields}
      ${nestedAuthor}
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
    ) { aggregate { count } }
  }
`
}

function buildPublicUserReviewsQuery(fields: string, nestedAuthor: string): string {
  return `
  query GetPublicUserReviews($authorId: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: {
        author_id: { _eq: $authorId }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      ${fields}
      ${nestedAuthor}
    }
    restaurant_reviews_aggregate(
      where: {
        author_id: { _eq: $authorId }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
    ) { aggregate { count } }
  }
`
}

function buildUserReviewsByStatusQuery(fields: string, nestedAuthor: string): string {
  return `
  query GetUserReviewsByStatus($authorId: uuid!, $status: String!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: $status } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      ${fields}
      ${nestedAuthor}
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: $status } }
    ) { aggregate { count } }
  }
`
}

function buildQuerySet(summary: boolean) {
  const primary = pickReviewFields(summary, true)
  const fallback = pickReviewFields(summary, false)
  return {
    all: buildAllUserReviewsQuery(primary, REVIEW_AUTHOR_GRAPHQL_NESTED),
    allFallback: buildAllUserReviewsQuery(fallback, ''),
    public: buildPublicUserReviewsQuery(primary, REVIEW_AUTHOR_GRAPHQL_NESTED),
    publicFallback: buildPublicUserReviewsQuery(fallback, ''),
    byStatus: buildUserReviewsByStatusQuery(primary, REVIEW_AUTHOR_GRAPHQL_NESTED),
    byStatusFallback: buildUserReviewsByStatusQuery(fallback, ''),
  }
}

const FULL_QUERIES = buildQuerySet(false)
const SUMMARY_QUERIES = buildQuerySet(true)

export const PRIVATE_REVIEW_STATUSES = new Set(['draft', 'pending'])
export const PUBLIC_REVIEW_STATUSES = new Set(['approved'])

type ReviewsQueryResult = {
  restaurant_reviews: Array<Record<string, unknown>>
  restaurant_reviews_aggregate: { aggregate: { count: number } }
}

async function queryWithFallback(
  logTag: string,
  primaryQuery: string,
  fallbackQuery: string,
  variables: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof hasuraQuery<ReviewsQueryResult>>>> {
  let result = await hasuraQuery<ReviewsQueryResult>(primaryQuery, variables)
  if (result.errors?.length) {
    console.warn(`${logTag} primary query failed, trying fallback:`, result.errors[0]?.message)
    result = await hasuraQuery<ReviewsQueryResult>(fallbackQuery, variables)
  }
  return result
}

export type ListUserReviewsInput = {
  authorId: string
  status?: string
  limit: number
  offset: number
  summary?: boolean
  canReadPrivate: boolean
  /** Attach `restaurant` briefs — skip for card grids to keep payloads small. */
  enrichRestaurants?: boolean
  logTag: string
}

export type ListUserReviewsResult = {
  reviews: Array<Record<string, unknown>>
  meta: { total: number; limit: number; offset: number; hasMore: boolean }
}

export async function listUserReviews(
  input: ListUserReviewsInput,
): Promise<{ ok: true; data: ListUserReviewsResult } | { ok: false; error: string }> {
  const {
    authorId,
    status,
    limit,
    offset,
    summary = false,
    canReadPrivate,
    enrichRestaurants = false,
    logTag,
  } = input

  if (!isValidUuid(authorId)) {
    return { ok: false, error: 'Invalid UUID format' }
  }
  if (status && !PRIVATE_REVIEW_STATUSES.has(status) && !PUBLIC_REVIEW_STATUSES.has(status)) {
    return { ok: false, error: 'Invalid status' }
  }

  const queries = summary ? SUMMARY_QUERIES : FULL_QUERIES
  const variables = status
    ? { authorId, status, limit, offset }
    : { authorId, limit, offset }

  const result = status
    ? await queryWithFallback(logTag, queries.byStatus, queries.byStatusFallback, variables)
    : canReadPrivate
      ? await queryWithFallback(logTag, queries.all, queries.allFallback, variables)
      : await queryWithFallback(logTag, queries.public, queries.publicFallback, variables)

  if (result.errors?.length) {
    console.error(logTag, result.errors)
    return { ok: false, error: 'Failed to fetch reviews' }
  }

  const reviewsRaw = result.data?.restaurant_reviews ?? []
  const total = result.data?.restaurant_reviews_aggregate?.aggregate?.count ?? 0
  const reviews = await safeEnrichReviewRows(reviewsRaw, { restaurants: enrichRestaurants })

  return {
    ok: true,
    data: {
      reviews,
      meta: { total, limit, offset, hasMore: offset + reviews.length < total },
    },
  }
}

import type { Request, Response } from 'express'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { hasuraQuery } from '../_lib/hasura'
import {
  enrichReviewRows,
  isValidUuid,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const REVIEW_ROW_FIELDS = `
  id title content rating images palates hashtags likes_count replies_count status
  created_at published_at author_id restaurant_uuid
`

const REVIEW_ROW_FIELDS_EXTENDED = `
  id title content rating images palates hashtags likes_count replies_count status
  created_at updated_at published_at author_id restaurant_uuid
`

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

const GET_ALL_USER_REVIEWS = buildAllUserReviewsQuery(
  REVIEW_ROW_FIELDS_EXTENDED,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
)
const GET_ALL_USER_REVIEWS_FALLBACK = buildAllUserReviewsQuery(REVIEW_ROW_FIELDS, '')

const GET_PUBLIC_USER_REVIEWS = buildPublicUserReviewsQuery(
  REVIEW_ROW_FIELDS_EXTENDED,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
)
const GET_PUBLIC_USER_REVIEWS_FALLBACK = buildPublicUserReviewsQuery(REVIEW_ROW_FIELDS, '')

const GET_USER_REVIEWS_BY_STATUS = buildUserReviewsByStatusQuery(
  REVIEW_ROW_FIELDS_EXTENDED,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
)
const GET_USER_REVIEWS_BY_STATUS_FALLBACK = buildUserReviewsByStatusQuery(REVIEW_ROW_FIELDS, '')

const PRIVATE_REVIEW_STATUSES = new Set(['draft', 'pending'])
const PUBLIC_REVIEW_STATUSES = new Set(['approved'])

type ReviewsQueryResult = {
  restaurant_reviews: Array<Record<string, unknown>>
  restaurant_reviews_aggregate: { aggregate: { count: number } }
}

async function queryWithFallback(
  primaryQuery: string,
  fallbackQuery: string,
  variables: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof hasuraQuery<ReviewsQueryResult>>>> {
  let result = await hasuraQuery<ReviewsQueryResult>(primaryQuery, variables)
  if (result.errors?.length) {
    console.warn(
      '[restaurant-reviews/get-user-reviews] primary query failed, trying fallback:',
      result.errors[0]?.message,
    )
    result = await hasuraQuery<ReviewsQueryResult>(fallbackQuery, variables)
  }
  return result
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const authorId = url.searchParams.get('author_id')
    const status = url.searchParams.get('status')?.toLowerCase() ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!authorId) return fail(res, 'Missing required param: author_id', 400)
    if (!isValidUuid(authorId)) return fail(res, 'Invalid UUID format', 400)
    if (status && !PRIVATE_REVIEW_STATUSES.has(status) && !PUBLIC_REVIEW_STATUSES.has(status)) {
      return fail(res, 'Invalid status', 400)
    }

    const auth = await resolveOptionalAuth(req, res)
    const authUserId = auth?.userId ?? null
    const hasBearer = Boolean(req.headers.authorization?.startsWith('Bearer '))
    const canReadPrivate = authUserId === authorId

    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !hasBearer) {
      return fail(res, 'Unauthorized', 401)
    }
    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !canReadPrivate) {
      return fail(res, 'Forbidden', 403)
    }

    const variables = status
      ? { authorId, status, limit, offset }
      : { authorId, limit, offset }

    const result = status
      ? await queryWithFallback(
          GET_USER_REVIEWS_BY_STATUS,
          GET_USER_REVIEWS_BY_STATUS_FALLBACK,
          variables,
        )
      : canReadPrivate
        ? await queryWithFallback(GET_ALL_USER_REVIEWS, GET_ALL_USER_REVIEWS_FALLBACK, variables)
        : await queryWithFallback(
            GET_PUBLIC_USER_REVIEWS,
            GET_PUBLIC_USER_REVIEWS_FALLBACK,
            variables,
          )

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-user-reviews]', result.errors)
      return fail(res, 'Failed to fetch user reviews', 500)
    }

    const reviewsRaw = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const reviews = await enrichReviewRows(reviewsRaw, { restaurants: true })

    ok(res, { reviews, meta: { total, limit, offset, hasMore: offset + reviews.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-user-reviews]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery } from '../_lib/hasura'
import {
  enrichReviewRows,
  isValidUuid,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_ALL_USER_REVIEWS = `
  query GetUserReviews($authorId: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id title content rating images palates hashtags likes_count replies_count status
      created_at published_at author_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
    ) { aggregate { count } }
  }
`

const GET_PUBLIC_USER_REVIEWS = `
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
      id title content rating images palates hashtags likes_count replies_count status
      created_at published_at author_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
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

const GET_USER_REVIEWS_BY_STATUS = `
  query GetUserReviewsByStatus($authorId: uuid!, $status: String!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: $status } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id title content rating images palates hashtags likes_count replies_count status
      created_at published_at author_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: $status } }
    ) { aggregate { count } }
  }
`

const PRIVATE_REVIEW_STATUSES = new Set(['draft', 'pending'])
const PUBLIC_REVIEW_STATUSES = new Set(['approved'])

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

    const hasBearer = req.headers.authorization?.startsWith('Bearer ') ?? false
    let authUserId: string | null = null

    if (hasBearer) {
      const payload = await requireAuth(req, res)
      if (!payload) return
      authUserId = getUserId(payload)
    }

    const canReadPrivate = authUserId === authorId

    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !hasBearer) {
      return fail(res, 'Unauthorized', 401)
    }
    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !canReadPrivate) {
      return fail(res, 'Forbidden', 403)
    }

    type Result = {
      restaurant_reviews: Array<Record<string, unknown>>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = status
      ? await hasuraQuery<Result>(GET_USER_REVIEWS_BY_STATUS, { authorId, status, limit, offset })
      : canReadPrivate
        ? await hasuraQuery<Result>(GET_ALL_USER_REVIEWS, { authorId, limit, offset })
        : await hasuraQuery<Result>(GET_PUBLIC_USER_REVIEWS, { authorId, limit, offset })

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

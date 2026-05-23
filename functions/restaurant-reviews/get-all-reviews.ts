import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { enrichReviewRows } from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const AUTHOR_NESTED = `
  AuthorProfile { user_id username palates user { avatarUrl email displayName } }
`

const GET_ALL_REVIEWS = `
  query GetAllReviews($limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "approved" } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id author_id content created_at hashtags images is_featured is_pinned likes_count mentions
      palates rating recognitions restaurant_uuid status title updated_at views_count published_at replies_count
      ${AUTHOR_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "approved" } }
    ) { aggregate { count } }
  }
`

const GET_ALL_REVIEWS_CURSOR = `
  query GetAllReviewsCursor($limit: Int!, $cursorCreatedAt: timestamptz!, $cursorId: uuid!) {
    restaurant_reviews(
      where: { _and: [
        { deleted_at: { _is_null: true } } { parent_review_id: { _is_null: true } } { status: { _eq: "approved" } }
        { _or: [{ created_at: { _lt: $cursorCreatedAt } } { _and: [{ created_at: { _eq: $cursorCreatedAt } } { id: { _lt: $cursorId } }] }] }
      ]}
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit
    ) {
      id author_id content created_at hashtags images is_featured is_pinned likes_count mentions
      palates rating recognitions restaurant_uuid status title updated_at views_count published_at replies_count
      ${AUTHOR_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "approved" } }
    ) { aggregate { count } }
  }
`

function encodeReviewCursor(created_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ created_at, id })).toString('base64url')
}

function decodeReviewCursor(cursor: string): { created_at: string; id: string } | null {
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { return null }
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0
    const cursor = url.searchParams.get('cursor') ?? undefined

    type ReviewsResult = {
      restaurant_reviews: Array<{ id: string; created_at: string; [key: string]: unknown }>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    let result: Awaited<ReturnType<typeof hasuraQuery<ReviewsResult>>>

    if (cursor) {
      const decoded = decodeReviewCursor(cursor)
      if (!decoded) return fail(res, 'Invalid cursor', 400)
      result = await hasuraQuery<ReviewsResult>(GET_ALL_REVIEWS_CURSOR, {
        limit,
        cursorCreatedAt: decoded.created_at,
        cursorId: decoded.id,
      })
    } else {
      result = await hasuraQuery<ReviewsResult>(GET_ALL_REVIEWS, { limit, offset })
    }

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-all-reviews]', result.errors)
      return fail(res, 'Failed to fetch reviews', 500)
    }

    const reviewsRaw = (result.data?.restaurant_reviews ?? []) as Array<
      Record<string, unknown> & { id: string; created_at: string }
    >
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const reviews = await enrichReviewRows(reviewsRaw)

    const lastItem = reviews[reviews.length - 1]
    const nextCursor = lastItem ? encodeReviewCursor(String(lastItem.created_at), String(lastItem.id)) : null
    const hasMore = cursor ? reviews.length === limit : offset + reviews.length < total

    ok(res, { reviews, meta: { total, limit, cursor: nextCursor, hasMore } })
  } catch (error) {
    console.error('[restaurant-reviews/get-all-reviews]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

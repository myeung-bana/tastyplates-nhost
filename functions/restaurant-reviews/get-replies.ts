import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import {
  isValidUuid,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
  safeEnrichReviewRows,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_REVIEW_REPLIES = `
  query GetReviewReplies($parentReviewId: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { parent_review_id: { _eq: $parentReviewId } deleted_at: { _is_null: true } status: { _eq: "approved" } }
      order_by: { created_at: desc }
      limit: $limit offset: $offset
    ) {
      id content likes_count created_at updated_at author_id
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { parent_review_id: { _eq: $parentReviewId } deleted_at: { _is_null: true } status: { _eq: "approved" } }
    ) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const reviewId = url.searchParams.get('review_id')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!reviewId) return fail(res, 'Missing required param: review_id', 400)
    if (!isValidUuid(reviewId)) return fail(res, 'Invalid UUID format', 400)

    type Result = {
      restaurant_reviews: Array<Record<string, unknown>>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<Result>(GET_REVIEW_REPLIES, {
      parentReviewId: reviewId,
      limit,
      offset,
    })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-replies]', result.errors)
      return fail(res, 'Failed to fetch replies', 500)
    }

    const repliesRaw = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const replies = await safeEnrichReviewRows(repliesRaw)

    ok(res, { replies, meta: { total, limit, offset, hasMore: offset + replies.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-replies]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

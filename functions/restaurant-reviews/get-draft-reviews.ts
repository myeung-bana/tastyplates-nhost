import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery } from '../_lib/hasura'
import { enrichReviewRows, REVIEW_AUTHOR_GRAPHQL_NESTED } from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_USER_DRAFT_REVIEWS = `
  query GetUserDraftReviews($authorId: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "draft" } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id title content rating images palates hashtags mentions recognitions
      likes_count replies_count status created_at updated_at published_at author_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "draft" } }
    ) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const authorId = getUserId(payload)

    const url = new URL(req.url, 'http://localhost')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    type Result = {
      restaurant_reviews: Array<Record<string, unknown>>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<Result>(GET_USER_DRAFT_REVIEWS, { authorId, limit, offset })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-draft-reviews]', result.errors)
      return fail(res, 'Failed to fetch draft reviews', 500)
    }

    const reviewsRaw = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const reviews = await enrichReviewRows(reviewsRaw, { restaurants: true })

    ok(res, { reviews, meta: { total, limit, offset, hasMore: offset + reviews.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-draft-reviews]', error)
    fail(res, 'Internal server error', 500)
  }
}

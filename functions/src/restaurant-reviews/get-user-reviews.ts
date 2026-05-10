import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_USER_REVIEWS = `
  query GetUserReviews($authorId: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id title content rating images palates hashtags likes_count replies_count status
      created_at published_at author_id restaurant_uuid
      AuthorProfile { user_id username palates user { avatarUrl email } }
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
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
      AuthorProfile { user_id username palates user { avatarUrl email } }
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _eq: $authorId } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: $status } }
    ) { aggregate { count } }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const authorId = url.searchParams.get('author_id')
    const status = url.searchParams.get('status') ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!authorId) return fail(res, 'Missing required param: author_id', 400)
    if (!UUID_REGEX.test(authorId)) return fail(res, 'Invalid UUID format', 400)

    type Result = {
      restaurant_reviews: unknown[]
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = status
      ? await hasuraQuery<Result>(GET_USER_REVIEWS_BY_STATUS, { authorId, status, limit, offset })
      : await hasuraQuery<Result>(GET_USER_REVIEWS, { authorId, limit, offset })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-user-reviews]', result.errors)
      return fail(res, 'Failed to fetch user reviews', 500)
    }

    const reviews = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    ok(res, { reviews, meta: { total, limit, offset, hasMore: offset + reviews.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-user-reviews]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

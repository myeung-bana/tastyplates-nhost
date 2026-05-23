import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { enrichReviewRows, isValidUuid } from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_REVIEWS_BY_RESTAURANT = `
  query GetReviewsByRestaurant($restaurantUuid: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { restaurant_uuid: { _eq: $restaurantUuid } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
      order_by: [{ is_pinned: desc }, { created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id title content rating images palates hashtags mentions recognitions likes_count replies_count
      status created_at published_at author_id restaurant_uuid is_pinned is_featured views_count updated_at
      AuthorProfile { user_id username palates user { avatarUrl email displayName } }
    }
    restaurant_reviews_aggregate(
      where: { restaurant_uuid: { _eq: $restaurantUuid } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } }
    ) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const restaurantUuid = url.searchParams.get('restaurant_uuid')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!restaurantUuid) return fail(res, 'Missing required param: restaurant_uuid', 400)
    if (!isValidUuid(restaurantUuid)) return fail(res, 'Invalid UUID format', 400)

    type Result = {
      restaurant_reviews: Array<Record<string, unknown>>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<Result>(GET_REVIEWS_BY_RESTAURANT, {
      restaurantUuid,
      limit,
      offset,
    })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-reviews-by-restaurant]', result.errors)
      return fail(res, 'Failed to fetch reviews', 500)
    }

    const reviewsRaw = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const reviews = await enrichReviewRows(reviewsRaw)

    ok(res, { reviews, meta: { total, limit, offset, hasMore: offset + reviews.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-reviews-by-restaurant]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery } from '../_lib/hasura'
import {
  enrichReviewRows,
  isValidUuid,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_FOLLOWING_IDS = `
  query GetFollowingIds($userId: uuid!) {
    restaurant_user_follows(where: { follower_id: { _eq: $userId } }) { user_id }
  }
`

const GET_FOLLOWING_FEED = `
  query GetFollowingFeed($authorIds: [uuid!]!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { author_id: { _in: $authorIds } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "approved" } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) {
      id title content rating images palates hashtags mentions recognitions
      likes_count replies_count status created_at published_at author_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
    restaurant_reviews_aggregate(
      where: { author_id: { _in: $authorIds } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "approved" } }
    ) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const authUserId = getUserId(payload)
    const url = new URL(req.url, 'http://localhost')
    const userId = url.searchParams.get('user_id') ?? authUserId
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0

    if (!userId) return fail(res, 'Missing required param: user_id', 400)
    if (!isValidUuid(userId)) return fail(res, 'Invalid UUID format', 400)
    if (userId !== authUserId) return fail(res, 'Forbidden', 403)

    type FollowingResult = { restaurant_user_follows: Array<{ user_id: string }> }
    const followResult = await hasuraQuery<FollowingResult>(GET_FOLLOWING_IDS, { userId })

    if (followResult.errors?.length) {
      console.error('[restaurant-reviews/get-following-feed]', followResult.errors)
      return fail(res, 'Failed to fetch following list', 500)
    }

    const authorIds = followResult.data?.restaurant_user_follows.map(f => f.user_id) ?? []

    if (authorIds.length === 0) {
      return ok(res, { reviews: [], meta: { total: 0, limit, offset, hasMore: false } })
    }

    type FeedResult = {
      restaurant_reviews: Array<Record<string, unknown>>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<FeedResult>(GET_FOLLOWING_FEED, { authorIds, limit, offset })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-following-feed]', result.errors)
      return fail(res, 'Failed to fetch feed', 500)
    }

    const reviewsRaw = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const reviews = await enrichReviewRows(reviewsRaw, {
      restaurants: true,
      includeRestaurantImage: false,
    })

    ok(res, { reviews, meta: { total, limit, offset, hasMore: offset + reviews.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-following-feed]', error)
    fail(res, 'Internal server error', 500)
  }
}

import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery } from '../_lib/hasura'
import {
  buildAuthorProfileMap,
  fetchRestaurantBriefMap,
  isValidUuid,
  normalizeAuthorIdKey,
  normalizeReviewAuthorFields,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
  safeEnrichReviewRows,
  type ReviewAuthorProfilePayload,
  type ReviewRestaurantBrief,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_FOLLOWING_IDS = `
  query GetFollowingIds($userId: uuid!) {
    restaurant_user_follows(where: { follower_id: { _eq: $userId } }) { user_id }
  }
`

const GET_FOLLOWING_REVIEWS = `
  query GetFollowingFeedReviews($authorIds: [uuid!]!, $limit: Int) {
    restaurant_reviews(
      where: { author_id: { _in: $authorIds } deleted_at: { _is_null: true } parent_review_id: { _is_null: true } status: { _eq: "approved" } }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit
    ) {
      id title content rating images palates hashtags mentions recognitions
      likes_count replies_count status created_at published_at author_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
  }
`

const GET_FOLLOWING_CHECKINS = `
  query GetFollowingCheckins($userIds: [uuid!]!, $limit: Int) {
    user_checkins(
      where: { user_id: { _in: $userIds } }
      order_by: [{ checked_in_at: desc }, { id: desc }]
      limit: $limit
    ) {
      id user_id restaurant_uuid checked_in_at
    }
  }
`

const GET_FOLLOWING_COMMENTS = `
  query GetFollowingComments($authorIds: [uuid!]!, $limit: Int) {
    restaurant_reviews(
      where: {
        author_id: { _in: $authorIds }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: false }
        status: { _eq: "approved" }
      }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit
    ) {
      id content created_at author_id parent_review_id restaurant_uuid
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
  }
`

type ActivityRow = {
  type: 'review' | 'checkin' | 'comment'
  id: string
  created_at: string
  author_id: string
  restaurant_uuid: string | null
  payload: Record<string, unknown>
}

function activitySortTime(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

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

    const authorIds = followResult.data?.restaurant_user_follows.map((f) => f.user_id) ?? []

    if (authorIds.length === 0) {
      return ok(res, {
        reviews: [],
        activities: [],
        meta: { total: 0, limit, offset, hasMore: false },
      })
    }

    const fetchLimit = Math.min(100, offset + limit + limit)

    type ReviewsResult = { restaurant_reviews: Array<Record<string, unknown>> }
    type CheckinsResult = {
      user_checkins: Array<{
        id: string
        user_id: string
        restaurant_uuid: string
        checked_in_at: string
      }>
    }
    type CommentsResult = { restaurant_reviews: Array<Record<string, unknown>> }

    const [reviewsResult, checkinsResult, commentsResult] = await Promise.all([
      hasuraQuery<ReviewsResult>(GET_FOLLOWING_REVIEWS, { authorIds, limit: fetchLimit }),
      hasuraQuery<CheckinsResult>(GET_FOLLOWING_CHECKINS, { userIds: authorIds, limit: fetchLimit }),
      hasuraQuery<CommentsResult>(GET_FOLLOWING_COMMENTS, { authorIds, limit: fetchLimit }),
    ])

    if (reviewsResult.errors?.length || checkinsResult.errors?.length || commentsResult.errors?.length) {
      console.error('[restaurant-reviews/get-following-feed]', {
        reviews: reviewsResult.errors,
        checkins: checkinsResult.errors,
        comments: commentsResult.errors,
      })
      return fail(res, 'Failed to fetch feed', 500)
    }

    const reviewsRaw = reviewsResult.data?.restaurant_reviews ?? []
    const reviews = await safeEnrichReviewRows(reviewsRaw, { restaurants: true })

    const checkinsRaw = checkinsResult.data?.user_checkins ?? []
    const commentsRaw = commentsResult.data?.restaurant_reviews ?? []

    for (const row of commentsRaw) {
      normalizeReviewAuthorFields(row)
    }

    const actorIds = [
      ...new Set([
        ...checkinsRaw.map((c) => c.user_id),
        ...commentsRaw.map((c) => String(c.author_id ?? '')),
      ].filter(isValidUuid)),
    ]
    const restaurantUuids = [
      ...new Set([
        ...checkinsRaw.map((c) => c.restaurant_uuid),
        ...commentsRaw.map((c) => String(c.restaurant_uuid ?? '')),
      ].filter(isValidUuid)),
    ]

    const [authorMap, restaurantMap] = await Promise.all([
      buildAuthorProfileMap(actorIds),
      fetchRestaurantBriefMap(restaurantUuids),
    ])

    const activities: ActivityRow[] = []

    for (const review of reviews) {
      activities.push({
        type: 'review',
        id: String(review.id),
        created_at: String(review.created_at),
        author_id: String(review.author_id),
        restaurant_uuid: review.restaurant_uuid ? String(review.restaurant_uuid) : null,
        payload: review as Record<string, unknown>,
      })
    }

    for (const checkin of checkinsRaw) {
      const profile = authorMap.get(normalizeAuthorIdKey(checkin.user_id)) ?? null
      const restaurant = restaurantMap.get(checkin.restaurant_uuid) ?? null
      activities.push({
        type: 'checkin',
        id: checkin.id,
        created_at: checkin.checked_in_at,
        author_id: checkin.user_id,
        restaurant_uuid: checkin.restaurant_uuid,
        payload: {
          id: checkin.id,
          user_id: checkin.user_id,
          restaurant_uuid: checkin.restaurant_uuid,
          checked_in_at: checkin.checked_in_at,
          AuthorProfile: profile,
          restaurant,
        },
      })
    }

    for (const comment of commentsRaw) {
      const authorId = String(comment.author_id ?? '')
      const restaurantUuid = comment.restaurant_uuid ? String(comment.restaurant_uuid) : null
      const fromGraphql = comment.AuthorProfile as ReviewAuthorProfilePayload | undefined
      const profile = fromGraphql ?? authorMap.get(normalizeAuthorIdKey(authorId)) ?? null
      const restaurant = restaurantUuid ? restaurantMap.get(restaurantUuid) ?? null : null
      activities.push({
        type: 'comment',
        id: String(comment.id),
        created_at: String(comment.created_at),
        author_id: authorId,
        restaurant_uuid: restaurantUuid,
        payload: {
          id: comment.id,
          content: comment.content ?? null,
          created_at: comment.created_at,
          author_id: authorId,
          parent_review_id: comment.parent_review_id ?? null,
          restaurant_uuid: restaurantUuid,
          AuthorProfile: profile,
          restaurant,
        },
      })
    }

    activities.sort((a, b) => activitySortTime(b.created_at) - activitySortTime(a.created_at))

    const page = activities.slice(offset, offset + limit)
    const hasMore = activities.length > offset + limit

    const reviewActivities = page.filter((a) => a.type === 'review').map((a) => a.payload)

    ok(res, {
      reviews: reviewActivities,
      activities: page.map(({ type, id, created_at, author_id, restaurant_uuid, payload }) => ({
        type,
        id,
        created_at,
        author_id,
        restaurant_uuid,
        ...payload,
      })),
      meta: {
        total: activities.length,
        limit,
        offset,
        hasMore,
      },
    })
  } catch (error) {
    console.error('[restaurant-reviews/get-following-feed]', error)
    fail(res, 'Internal server error', 500)
  }
}

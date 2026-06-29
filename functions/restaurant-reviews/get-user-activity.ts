import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { listUserReviews } from '../_lib/list-user-reviews'
import {
  buildAuthorProfileMap,
  fetchRestaurantBriefMap,
  isValidUuid,
  normalizeAuthorIdKey,
  normalizeReviewAuthorFields,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
  type ReviewAuthorProfilePayload,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_USER_CHECKINS = `
  query GetUserActivityCheckins($userId: uuid!, $limit: Int) {
    user_checkins(
      where: { user_id: { _eq: $userId } }
      order_by: [{ checked_in_at: desc }, { id: desc }]
      limit: $limit
    ) {
      id user_id restaurant_uuid checked_in_at
    }
  }
`

const GET_USER_COMMENTS = `
  query GetUserActivityComments($authorId: uuid!, $limit: Int) {
    restaurant_reviews(
      where: {
        author_id: { _eq: $authorId }
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

/** Mixed profile activity (reviews via shared `listUserReviews`, plus check-ins and comments). */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const userId = url.searchParams.get('user_id')?.trim() ?? ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '3', 10), 20)
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0

    if (!userId) return fail(res, 'Missing required param: user_id', 400)
    if (!isValidUuid(userId)) return fail(res, 'Invalid UUID format', 400)

    const auth = await resolveOptionalAuth(req, res)
    const authUserId = auth?.userId ?? null
    const canReadPrivate = authUserId === userId

    const fetchLimit = Math.min(30, offset + limit + limit)

    type CheckinsResult = {
      user_checkins: Array<{
        id: string
        user_id: string
        restaurant_uuid: string
        checked_in_at: string
      }>
    }
    type CommentsResult = { restaurant_reviews: Array<Record<string, unknown>> }

    const [reviewsList, checkinsResult, commentsResult] = await Promise.all([
      listUserReviews({
        authorId: userId,
        limit: fetchLimit,
        offset: 0,
        summary: false,
        canReadPrivate,
        enrichRestaurants: true,
        logTag: '[restaurant-reviews/get-user-activity]',
      }),
      hasuraQuery<CheckinsResult>(GET_USER_CHECKINS, { userId, limit: fetchLimit }),
      hasuraQuery<CommentsResult>(GET_USER_COMMENTS, { authorId: userId, limit: fetchLimit }),
    ])

    if (!reviewsList.ok) {
      return fail(res, reviewsList.error, 500)
    }

    if (checkinsResult.errors?.length || commentsResult.errors?.length) {
      console.error('[restaurant-reviews/get-user-activity]', {
        checkins: checkinsResult.errors,
        comments: commentsResult.errors,
      })
      return fail(res, 'Failed to fetch activity', 500)
    }

    const reviews = reviewsList.data.reviews
    const checkinsRaw = checkinsResult.data?.user_checkins ?? []
    const commentsRaw = commentsResult.data?.restaurant_reviews ?? []

    for (const row of commentsRaw) {
      normalizeReviewAuthorFields(row)
    }

    const actorIds = [
      ...new Set([
        userId,
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
        payload: review,
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

    ok(res, {
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
    console.error('[restaurant-reviews/get-user-activity]', error)
    fail(res, 'Internal server error', 500)
  }
}

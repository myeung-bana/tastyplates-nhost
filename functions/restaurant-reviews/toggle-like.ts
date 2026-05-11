import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery, hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const ToggleLikeSchema = z.object({ review_id: z.string().uuid() })

const CHECK_REVIEW_LIKE = `
  query CheckReviewLike($reviewId: uuid!, $userId: uuid!) {
    restaurant_review_likes(where: { review_id: { _eq: $reviewId } user_id: { _eq: $userId } } limit: 1) { id }
  }
`

const INSERT_REVIEW_LIKE = `
  mutation InsertReviewLike($reviewId: uuid!, $userId: uuid!) {
    insert_restaurant_review_likes_one(object: { review_id: $reviewId user_id: $userId }
      on_conflict: { constraint: restaurant_review_likes_unique update_columns: [] }) { id created_at }
  }
`

const DELETE_REVIEW_LIKE = `
  mutation DeleteReviewLike($reviewId: uuid!, $userId: uuid!) {
    delete_restaurant_review_likes(where: { review_id: { _eq: $reviewId } user_id: { _eq: $userId } }) { affected_rows }
  }
`

const UPDATE_LIKES_COUNT = `
  mutation UpdateLikesCount($id: uuid!, $delta: Int!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id } _inc: { likes_count: $delta }) { id likes_count }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost')
      const reviewId = url.searchParams.get('review_id')
      const userId = url.searchParams.get('user_id')

      if (!reviewId || !userId) return fail(res, 'Missing required params: review_id, user_id', 400)
      if (!UUID_REGEX.test(reviewId) || !UUID_REGEX.test(userId)) return fail(res, 'Invalid UUID format', 400)

      type LikeResult = { restaurant_review_likes: Array<{ id: string }> }
      const result = await hasuraQuery<LikeResult>(CHECK_REVIEW_LIKE, { reviewId, userId })
      if (result.errors?.length) {
        console.error('[restaurant-reviews/toggle-like GET]', result.errors)
        return fail(res, 'Failed to check like status', 500)
      }

      return ok(res, { liked: (result.data?.restaurant_review_likes ?? []).length > 0 })
    }

    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    const bodyParsed = ToggleLikeSchema.safeParse(req.body)
    if (!bodyParsed.success) {
      return fail(res, 'Validation failed', 422, bodyParsed.error.issues)
    }
    const { review_id: reviewId } = bodyParsed.data

    type LikeResult = { restaurant_review_likes: Array<{ id: string }> }
    const checkResult = await hasuraQuery<LikeResult>(CHECK_REVIEW_LIKE, { reviewId, userId })

    if (checkResult.errors?.length) {
      console.error('[restaurant-reviews/toggle-like]', checkResult.errors)
      return fail(res, 'Failed to check like status', 500)
    }

    const isLiked = (checkResult.data?.restaurant_review_likes ?? []).length > 0

    if (isLiked) {
      await hasuraMutation(DELETE_REVIEW_LIKE, { reviewId, userId })
      await hasuraMutation(UPDATE_LIKES_COUNT, { id: reviewId, delta: -1 })
      return ok(res, { liked: false, reviewId })
    } else {
      await hasuraMutation(INSERT_REVIEW_LIKE, { reviewId, userId })
      await hasuraMutation(UPDATE_LIKES_COUNT, { id: reviewId, delta: 1 })
      return ok(res, { liked: true, reviewId })
    }
  } catch (error) {
    console.error('[restaurant-reviews/toggle-like]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

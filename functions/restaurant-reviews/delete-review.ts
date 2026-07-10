import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery, hasuraMutation } from '../_lib/hasura'
import { scheduleRatingSummaryRebuild } from '../_lib/rebuildRatingSummary'
import { ok, fail } from '../_lib/respond'

const GET_REVIEW_AUTHOR = `
  query GetReviewAuthor($id: uuid!) {
    restaurant_reviews_by_pk(id: $id) { id author_id restaurant_uuid }
  }
`

const DELETE_REVIEW = `
  mutation DeleteReview($id: uuid!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id } _set: { deleted_at: "now()" }) {
      id restaurant_uuid parent_review_id deleted_at
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')

    if (!id) return fail(res, 'Missing required param: id', 400)
    if (!UUID_REGEX.test(id)) return fail(res, 'Invalid UUID format', 400)

    type AuthorResult = { restaurant_reviews_by_pk: { id: string; author_id: string; restaurant_uuid: string } | null }
    const authCheck = await hasuraQuery<AuthorResult>(GET_REVIEW_AUTHOR, { id })

    if (authCheck.errors?.length) {
      console.error('[restaurant-reviews/delete-review]', authCheck.errors)
      return fail(res, 'Failed to fetch review', 500)
    }

    const review = authCheck.data?.restaurant_reviews_by_pk
    if (!review) return fail(res, 'Review not found', 404)
    if (review.author_id !== userId) return fail(res, 'Forbidden', 403)

    type DeleteResult = { update_restaurant_reviews_by_pk: unknown }
    await hasuraMutation<DeleteResult>(DELETE_REVIEW, { id })

    scheduleRatingSummaryRebuild(review.restaurant_uuid)

    ok(res, { deleted: true, id })
  } catch (error) {
    console.error('[restaurant-reviews/delete-review]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

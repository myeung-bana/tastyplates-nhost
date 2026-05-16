import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery, hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const UpdateReviewSchema = z.object({
  id: z.string().uuid(),
  title: z.string().optional(),
  content: z.string().min(1).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  status: z.enum(['approved', 'draft', 'pending']).optional(),
  images: z.array(z.string()).optional(),
  palates: z.unknown().optional(),
  hashtags: z.array(z.string()).optional(),
  recognitions: z.unknown().optional(),
})

const GET_REVIEW_AUTHOR = `
  query GetReviewAuthor($id: uuid!) {
    restaurant_reviews_by_pk(id: $id) { id author_id restaurant_uuid }
  }
`

const UPDATE_REVIEW = `
  mutation UpdateReview($id: uuid!, $changes: restaurant_reviews_set_input!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id } _set: $changes) {
      id restaurant_uuid title content rating images palates hashtags status updated_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    const body = validate(req, res, UpdateReviewSchema)
    if (!body) return

    type AuthorResult = { restaurant_reviews_by_pk: { id: string; author_id: string; restaurant_uuid: string } | null }
    const authCheck = await hasuraQuery<AuthorResult>(GET_REVIEW_AUTHOR, { id: body.id })

    if (authCheck.errors?.length) {
      console.error('[restaurant-reviews/update-review]', authCheck.errors)
      return fail(res, 'Failed to fetch review', 500)
    }

    const review = authCheck.data?.restaurant_reviews_by_pk
    if (!review) return fail(res, 'Review not found', 404)
    if (review.author_id !== userId) return fail(res, 'Forbidden', 403)

    const { id, ...changes } = body

    type UpdateResult = { update_restaurant_reviews_by_pk: unknown }
    const data = await hasuraMutation<UpdateResult>(UPDATE_REVIEW, { id, changes })

    ok(res, { review: data.update_restaurant_reviews_by_pk })
  } catch (error) {
    console.error('[restaurant-reviews/update-review]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

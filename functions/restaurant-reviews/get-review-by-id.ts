import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_REVIEW_BY_ID = `
  query GetReviewById($id: uuid!) {
    restaurant_reviews_by_pk(id: $id) {
      id restaurant_uuid author_id parent_review_id title content rating images palates hashtags mentions
      recognitions likes_count replies_count status is_pinned is_featured created_at updated_at published_at deleted_at
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')

    if (!id) return fail(res, 'Missing required param: id', 400)
    if (!UUID_REGEX.test(id)) return fail(res, 'Invalid UUID format', 400)

    type Result = { restaurant_reviews_by_pk: unknown | null }
    const result = await hasuraQuery<Result>(GET_REVIEW_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-review-by-id]', result.errors)
      return fail(res, 'Failed to fetch review', 500)
    }

    const review = result.data?.restaurant_reviews_by_pk
    if (!review) return fail(res, 'Review not found', 404)

    ok(res, { review })
  } catch (error) {
    console.error('[restaurant-reviews/get-review-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

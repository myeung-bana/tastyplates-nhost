import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateReviewSchema = z.object({
  restaurant_uuid: z.string().uuid(),
  title: z.string().optional(),
  content: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  status: z.enum(['approved', 'draft']).default('approved'),
  images: z.array(z.string()).optional(),
  palates: z.unknown().optional(),
  hashtags: z.array(z.string()).optional(),
  recognitions: z.unknown().optional(),
})

const CREATE_REVIEW = `
  mutation CreateReview($object: restaurant_reviews_insert_input!) {
    insert_restaurant_reviews_one(object: $object) {
      id title content rating status created_at restaurant_uuid author_id
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const authorId = getUserId(payload)

    const body = validate(req, res, CreateReviewSchema)
    if (!body) return

    // TODO: Rating rebuild should be triggered asynchronously via a Hasura event trigger
    type Result = { insert_restaurant_reviews_one: unknown }
    const result = await hasuraMutation<Result>(CREATE_REVIEW, {
      object: { ...body, author_id: authorId },
    })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/create-review]', result.errors)
      return fail(res, 'Failed to create review', 500)
    }

    ok(res, { review: result.data?.insert_restaurant_reviews_one }, 201)
  } catch (error) {
    console.error('[restaurant-reviews/create-review]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateCommentSchema = z.object({
  parent_review_id: z.string().uuid(),
  content: z.string().min(1).max(2000),
  restaurant_uuid: z.string().uuid(),
})

const CREATE_COMMENT = `
  mutation CreateComment($object: restaurant_reviews_insert_input!) {
    insert_restaurant_reviews_one(object: $object) {
      id content created_at author_id parent_review_id restaurant_uuid
    }
  }
`

const INCREMENT_REPLIES_COUNT = `
  mutation IncrementRepliesCount($id: uuid!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id } _inc: { replies_count: 1 }) { id replies_count }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const authorId = getUserId(payload)

    const body = validate(req, res, CreateCommentSchema)
    if (!body) return

    type CreateResult = { insert_restaurant_reviews_one: unknown }
    const result = await hasuraMutation<CreateResult>(CREATE_COMMENT, {
      object: { ...body, author_id: authorId },
    })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/create-comment]', result.errors)
      return fail(res, 'Failed to create comment', 500)
    }

    await hasuraMutation(INCREMENT_REPLIES_COUNT, { id: body.parent_review_id })

    ok(res, { comment: result.data?.insert_restaurant_reviews_one }, 201)
  } catch (error) {
    console.error('[restaurant-reviews/create-comment]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

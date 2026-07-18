/**
 * POST `admin/moderate-review`
 * Header: `x-admin-secret`
 * Body: `{ id: uuid, status: "approved"|"pending"|"rejected"|"draft", moderation_note?: string }`
 *
 * Sets review status (admin bypass of owner JWT) and schedules rating summary rebuild.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'

import { ADMIN_SECRET } from '../_lib/env'
import { hasuraAdmin, hasuraQuery } from '../_lib/hasura'
import { isValidUuid } from '../_lib/review-enrichment'
import { scheduleRatingSummaryRebuild } from '../_lib/rebuildRatingSummary'
import { fail, ok } from '../_lib/respond'
import { validate } from '../_lib/validate'

const BodySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['approved', 'pending', 'rejected', 'draft']),
  moderation_note: z.string().max(2000).optional(),
})

const GET_REVIEW = `
  query AdminModerateGetReview($id: uuid!) {
    restaurant_reviews_by_pk(id: $id) {
      id
      status
      restaurant_uuid
      deleted_at
      parent_review_id
    }
  }
`

const UPDATE_REVIEW_STATUS = `
  mutation AdminModerateUpdateReview($id: uuid!, $status: String!) {
    update_restaurant_reviews_by_pk(
      pk_columns: { id: $id }
      _set: { status: $status, updated_at: "now()" }
    ) {
      id
      status
      restaurant_uuid
      updated_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    const body = validate(req, res, BodySchema)
    if (!body) return

    if (!isValidUuid(body.id)) {
      return fail(res, 'Invalid review id', 400)
    }

    type GetResult = {
      restaurant_reviews_by_pk: {
        id: string
        status: string
        restaurant_uuid: string | null
        deleted_at: string | null
        parent_review_id: string | null
      } | null
    }

    const existing = await hasuraQuery<GetResult>(GET_REVIEW, { id: body.id })
    if (existing.errors?.length) {
      console.error('[admin/moderate-review]', existing.errors)
      return fail(res, 'Failed to load review', 500)
    }

    const review = existing.data?.restaurant_reviews_by_pk
    if (!review || review.deleted_at) {
      return fail(res, 'Review not found', 404)
    }
    if (review.parent_review_id) {
      return fail(res, 'Cannot moderate reply threads via this endpoint', 400)
    }

    type UpdateResult = {
      update_restaurant_reviews_by_pk: {
        id: string
        status: string
        restaurant_uuid: string | null
        updated_at: string
      } | null
    }

    const updated = await hasuraAdmin<UpdateResult>(UPDATE_REVIEW_STATUS, {
      id: body.id,
      status: body.status,
    })

    const row = updated.update_restaurant_reviews_by_pk
    if (!row) {
      return fail(res, 'Review not found', 404)
    }

    if (row.restaurant_uuid) {
      scheduleRatingSummaryRebuild(row.restaurant_uuid)
    }

    if (body.moderation_note?.trim()) {
      console.info(
        '[admin/moderate-review] note',
        row.id,
        body.status,
        body.moderation_note.trim().slice(0, 200),
      )
    }

    ok(res, {
      review: row,
      previous_status: review.status,
      rebuild_scheduled: Boolean(row.restaurant_uuid),
    })
  } catch (error) {
    console.error('[admin/moderate-review]', error)
    fail(res, 'Internal server error', 500)
  }
}

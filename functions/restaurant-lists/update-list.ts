/**
 * PATCH /v1/restaurant-lists/update-list
 *
 * Body: { list_uuid: string, title?: string, description?: string, is_public?: boolean }
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const UpdateListSchema = z.object({
  list_uuid: z.string().uuid(),
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  is_public: z.boolean().optional(),
}).refine(
  (d) => d.title !== undefined || d.description !== undefined || d.is_public !== undefined,
  { message: 'At least one of title, description, or is_public must be provided' },
)

const VERIFY_OWNERSHIP = `
  query VerifyListOwnership($uuid: uuid!, $ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid }, owner_id: { _eq: $ownerId } }
      limit: 1
    ) { id }
  }
`

const UPDATE_LIST = `
  mutation UpdateList($uuid: uuid!, $set: recommended_restaurant_lists_set_input!) {
    update_recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid } }
      _set: $set
    ) {
      returning {
        id uuid slug title description is_public updated_at
      }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, UpdateListSchema)
    if (!body) return

    type OwnerCheck = { recommended_restaurant_lists: { id: number }[] }
    const check = await hasuraAdmin<OwnerCheck>(VERIFY_OWNERSHIP, {
      uuid: body.list_uuid,
      ownerId,
    })
    if ((check.recommended_restaurant_lists ?? []).length === 0) {
      fail(res, 'List not found', 404)
      return
    }

    const set: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.title !== undefined) set.title = body.title
    if (body.description !== undefined) set.description = body.description
    if (body.is_public !== undefined) set.is_public = body.is_public

    type Result = { update_recommended_restaurant_lists: { returning: unknown[] } }
    const data = await hasuraAdmin<Result>(UPDATE_LIST, { uuid: body.list_uuid, set })

    ok(res, { list: data.update_recommended_restaurant_lists.returning[0] })
  } catch (error) {
    console.error('[restaurant-lists/update-list]', error)
    fail(res, 'Failed to update list', 500)
  }
}

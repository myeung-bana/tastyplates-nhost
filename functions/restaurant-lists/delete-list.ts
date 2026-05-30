/**
 * DELETE /v1/restaurant-lists/delete-list
 *
 * Permanently deletes an owned list. Items are removed first (cascade by
 * application layer) then the list itself. Ownership verified before delete.
 *
 * Body: { list_uuid: string }
 * Auth: Required.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const DeleteListSchema = z.object({
  list_uuid: z.string().uuid(),
})

const VERIFY_OWNERSHIP = `
  query VerifyListOwnership($uuid: uuid!, $ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid }, owner_id: { _eq: $ownerId } }
      limit: 1
    ) { id }
  }
`

const DELETE_ITEMS = `
  mutation DeleteListItems($listUuid: uuid!) {
    delete_recommended_restaurant_list_items(
      where: { list_id: { _eq: $listUuid } }
    ) { affected_rows }
  }
`

const DELETE_LIST = `
  mutation DeleteList($uuid: uuid!) {
    delete_recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid } }
    ) { affected_rows }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, DeleteListSchema)
    if (!body) return

    type OwnerCheck = { recommended_restaurant_lists: { id: number }[] }
    const check = await hasuraAdmin<OwnerCheck>(VERIFY_OWNERSHIP, {
      uuid: body.list_uuid,
      ownerId,
    })
    const rows = check.recommended_restaurant_lists ?? []
    if (rows.length === 0) {
      fail(res, 'List not found', 404)
      return
    }

    // Explicit cascade: delete items first, then the list
    await hasuraAdmin(DELETE_ITEMS, { listUuid: body.list_uuid })
    await hasuraAdmin(DELETE_LIST, { uuid: body.list_uuid })

    ok(res, { deleted: true })
  } catch (error) {
    console.error('[restaurant-lists/delete-list]', error)
    fail(res, 'Failed to delete list', 500)
  }
}

/**
 * DELETE /v1/restaurant-lists/remove-item
 *
 * Removes an item from a user-owned list. Verifies both list ownership and
 * that the item actually belongs to the specified list before deleting.
 *
 * Body: { list_uuid: string, item_id: number }
 * Auth: Required.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const RemoveItemSchema = z.object({
  list_uuid: z.string().uuid(),
  item_id: z.number().int().positive(),
})

const VERIFY_ITEM_OWNERSHIP = `
  query VerifyItemOwnership($listUuid: uuid!, $ownerId: uuid!, $itemId: Int!) {
    recommended_restaurant_list_items(
      where: {
        id: { _eq: $itemId }
        list: {
          uuid: { _eq: $listUuid }
          owner_id: { _eq: $ownerId }
        }
      }
      limit: 1
    ) { id }
  }
`

const DELETE_ITEM = `
  mutation DeleteListItem($itemId: Int!) {
    delete_recommended_restaurant_list_items_by_pk(id: $itemId) { id }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, RemoveItemSchema)
    if (!body) return

    type OwnerCheck = { recommended_restaurant_list_items: { id: number }[] }
    const check = await hasuraAdmin<OwnerCheck>(VERIFY_ITEM_OWNERSHIP, {
      listUuid: body.list_uuid,
      ownerId,
      itemId: body.item_id,
    })

    if ((check.recommended_restaurant_list_items ?? []).length === 0) {
      fail(res, 'Item not found', 404)
      return
    }

    await hasuraAdmin(DELETE_ITEM, { itemId: body.item_id })

    ok(res, { deleted: true })
  } catch (error) {
    console.error('[restaurant-lists/remove-item]', error)
    fail(res, 'Failed to remove item', 500)
  }
}

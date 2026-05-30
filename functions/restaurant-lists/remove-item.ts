/**
 * DELETE /v1/restaurant-lists/remove-item
 *
 * Removes an item from a user-owned list. Verifies list ownership and
 * that the item belongs to the list (by list_id = list uuid) before deleting.
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

const VERIFY_LIST_OWNERSHIP = `
  query VerifyListOwnership($listUuid: uuid!, $ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $listUuid }, owner_id: { _eq: $ownerId } }
      limit: 1
    ) { uuid }
  }
`

const VERIFY_ITEM_ON_LIST = `
  query VerifyItemOnList($listUuid: uuid!, $itemId: Int!) {
    recommended_restaurant_list_items(
      where: { id: { _eq: $itemId }, list_id: { _eq: $listUuid } }
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

    type ListCheck = { recommended_restaurant_lists: { uuid: string }[] }
    const listCheck = await hasuraAdmin<ListCheck>(VERIFY_LIST_OWNERSHIP, {
      listUuid: body.list_uuid,
      ownerId,
    })
    if ((listCheck.recommended_restaurant_lists ?? []).length === 0) {
      fail(res, 'Item not found', 404)
      return
    }

    type ItemCheck = { recommended_restaurant_list_items: { id: number }[] }
    const itemCheck = await hasuraAdmin<ItemCheck>(VERIFY_ITEM_ON_LIST, {
      listUuid: body.list_uuid,
      itemId: body.item_id,
    })
    if ((itemCheck.recommended_restaurant_list_items ?? []).length === 0) {
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

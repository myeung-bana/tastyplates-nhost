/**
 * PATCH /v1/restaurant-lists/reorder-items
 *
 * Bulk-updates sort_order for all items in a list. The caller must supply
 * a complete array of { item_id, sort_order } pairs covering every item.
 * Ownership is verified before any writes.
 *
 * Body: { list_uuid: string, order: Array<{ item_id: number, sort_order: number }> }
 * Auth: Required.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const ReorderItemsSchema = z.object({
  list_uuid: z.string().uuid(),
  order: z
    .array(
      z.object({
        item_id: z.number().int().positive(),
        sort_order: z.number().int().min(0),
      }),
    )
    .min(1),
})

const VERIFY_OWNERSHIP = `
  query VerifyListOwnership($uuid: uuid!, $ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid }, owner_id: { _eq: $ownerId } }
      limit: 1
    ) { id }
  }
`

// Hasura doesn't support UPDATE…CASE in a single mutation easily so we
// issue individual update_by_pk calls in parallel. For lists up to 200
// items this is fast enough; a bulk approach can replace this later.
const UPDATE_SORT_ORDER = `
  mutation UpdateSortOrder($itemId: Int!, $sortOrder: Int!) {
    update_recommended_restaurant_list_items_by_pk(
      pk_columns: { id: $itemId }
      _set: { sort_order: $sortOrder }
    ) { id sort_order }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, ReorderItemsSchema)
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

    await Promise.all(
      body.order.map(({ item_id, sort_order }) =>
        hasuraAdmin(UPDATE_SORT_ORDER, { itemId: item_id, sortOrder: sort_order }),
      ),
    )

    ok(res, { reordered: body.order.length })
  } catch (error) {
    console.error('[restaurant-lists/reorder-items]', error)
    fail(res, 'Failed to reorder items', 500)
  }
}

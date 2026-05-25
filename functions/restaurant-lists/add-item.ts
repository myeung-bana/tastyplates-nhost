/**
 * POST /v1/restaurant-lists/add-item
 *
 * Adds a restaurant to a user-owned list. Accepts either a TP `restaurant_uuid`
 * (for listed venues) or a `google_place_id` (for Google-only places), or both.
 * Returns 409 if the item already exists in the list.
 *
 * Body: { list_uuid: string, restaurant_uuid?: string, google_place_id?: string }
 * Auth: Required.
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const MAX_ITEMS_PER_LIST = 200

const AddItemSchema = z.object({
  list_uuid: z.string().uuid(),
  restaurant_uuid: z.string().uuid().optional(),
  google_place_id: z.string().min(1).max(500).optional(),
}).refine(
  (d) => d.restaurant_uuid !== undefined || d.google_place_id !== undefined,
  { message: 'At least one of restaurant_uuid or google_place_id is required' },
)

const VERIFY_OWNERSHIP = `
  query VerifyListOwnership($uuid: uuid!, $ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid }, owner_id: { _eq: $ownerId } }
      limit: 1
    ) {
      id
      items_aggregate: recommended_restaurant_list_items_aggregate { aggregate { count } }
    }
  }
`

const CHECK_DUPLICATE = `
  query CheckDuplicate($listId: Int!, $restaurantUuid: uuid, $googlePlaceId: String) {
    recommended_restaurant_list_items(
      where: {
        list_id: { _eq: $listId }
        _or: [
          { restaurant_uuid: { _eq: $restaurantUuid } }
          { google_place_id: { _eq: $googlePlaceId } }
        ]
      }
      limit: 1
    ) { id }
  }
`

const GET_MAX_SORT_ORDER = `
  query GetMaxSortOrder($listId: Int!) {
    recommended_restaurant_list_items_aggregate(
      where: { list_id: { _eq: $listId } }
    ) { aggregate { max { sort_order } } }
  }
`

const INSERT_ITEM = `
  mutation InsertListItem(
    $listId: Int!, $sortOrder: Int!,
    $restaurantUuid: uuid, $googlePlaceId: String
  ) {
    insert_recommended_restaurant_list_items_one(object: {
      list_id: $listId
      sort_order: $sortOrder
      restaurant_uuid: $restaurantUuid
      google_place_id: $googlePlaceId
    }) {
      id list_id sort_order restaurant_uuid google_place_id created_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, AddItemSchema)
    if (!body) return

    type OwnerCheck = {
      recommended_restaurant_lists: Array<{
        id: number
        items_aggregate: { aggregate: { count: number } }
      }>
    }
    const check = await hasuraAdmin<OwnerCheck>(VERIFY_OWNERSHIP, {
      uuid: body.list_uuid,
      ownerId,
    })
    const listRows = check.recommended_restaurant_lists ?? []
    if (listRows.length === 0) {
      fail(res, 'List not found', 404)
      return
    }

    const listId = listRows[0].id
    const currentCount = listRows[0].items_aggregate.aggregate.count

    if (currentCount >= MAX_ITEMS_PER_LIST) {
      fail(res, `Lists are capped at ${MAX_ITEMS_PER_LIST} items`, 422)
      return
    }

    // Duplicate check — 409 if already in list
    type DupCheck = { recommended_restaurant_list_items: { id: number }[] }
    const dup = await hasuraAdmin<DupCheck>(CHECK_DUPLICATE, {
      listId,
      restaurantUuid: body.restaurant_uuid ?? null,
      googlePlaceId: body.google_place_id ?? null,
    })
    if ((dup.recommended_restaurant_list_items ?? []).length > 0) {
      fail(res, 'Item already in list', 409)
      return
    }

    // Append at end
    type MaxSort = { recommended_restaurant_list_items_aggregate: { aggregate: { max: { sort_order: number | null } } } }
    const maxData = await hasuraAdmin<MaxSort>(GET_MAX_SORT_ORDER, { listId })
    const maxOrder = maxData.recommended_restaurant_list_items_aggregate.aggregate.max.sort_order ?? 0
    const sortOrder = maxOrder + 1

    type InsertResult = { insert_recommended_restaurant_list_items_one: unknown }
    const data = await hasuraAdmin<InsertResult>(INSERT_ITEM, {
      listId,
      sortOrder,
      restaurantUuid: body.restaurant_uuid ?? null,
      googlePlaceId: body.google_place_id ?? null,
    })

    ok(res, { item: data.insert_recommended_restaurant_list_items_one }, 201)
  } catch (error) {
    console.error('[restaurant-lists/add-item]', error)
    fail(res, 'Failed to add item', 500)
  }
}

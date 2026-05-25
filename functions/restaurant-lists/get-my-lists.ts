/**
 * GET /v1/restaurant-lists/get-my-lists
 *
 * Returns all lists owned by the authenticated user (owner_id = JWT x-hasura-user-id),
 * ordered by most recently updated.
 */
import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_MY_LISTS = `
  query GetMyLists($ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { owner_id: { _eq: $ownerId } }
      order_by: { updated_at: desc }
    ) {
      id uuid slug title description is_public is_active
      share_token created_at updated_at
      items_aggregate: recommended_restaurant_list_items_aggregate {
        aggregate { count }
      }
      first_item: recommended_restaurant_list_items(
        order_by: { sort_order: asc }
        limit: 1
      ) {
        restaurant_uuid google_place_id
        restaurant { featured_image_url title }
      }
    }
  }
`

type RawList = {
  id: number
  uuid: string
  slug: string
  title: string
  description: string | null
  is_public: boolean
  is_active: boolean
  share_token: string | null
  created_at: string
  updated_at: string
  items_aggregate: { aggregate: { count: number } }
  first_item: Array<{
    restaurant_uuid: string | null
    google_place_id: string | null
    restaurant: { featured_image_url: string | null; title: string } | null
  }>
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    type Result = { recommended_restaurant_lists: RawList[] }
    const data = await hasuraAdmin<Result>(GET_MY_LISTS, { ownerId })

    const lists = (data.recommended_restaurant_lists ?? []).map((list) => ({
      id: list.id,
      uuid: list.uuid,
      slug: list.slug,
      title: list.title,
      description: list.description,
      is_public: list.is_public,
      is_active: list.is_active,
      share_token: list.share_token,
      created_at: list.created_at,
      updated_at: list.updated_at,
      items_count: list.items_aggregate.aggregate.count,
      cover_image_url: list.first_item[0]?.restaurant?.featured_image_url ?? null,
    }))

    ok(res, lists)
  } catch (error) {
    console.error('[restaurant-lists/get-my-lists]', error)
    fail(res, 'Failed to fetch lists', 500)
  }
}

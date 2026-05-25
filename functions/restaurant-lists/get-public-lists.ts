/**
 * GET /v1/restaurant-lists/get-public-lists?page=<n>&limit=<n>
 *
 * Paginated browse of all active public lists, ordered by most recently
 * updated. Returns summary cards (no items or share_token). Unauthenticated.
 *
 * Query params:
 *   page  — 0-indexed page number (default 0)
 *   limit — items per page (default 20, max 50)
 *
 * Auth: None.
 */
import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_PUBLIC_LISTS = `
  query GetPublicLists($limit: Int!, $offset: Int!) {
    recommended_restaurant_lists(
      where: {
        is_public: { _eq: true }
        is_active: { _eq: true }
        owner_id: { _is_null: false }
      }
      order_by: { updated_at: desc }
      limit: $limit
      offset: $offset
    ) {
      uuid slug title description owner_id created_at updated_at
      owner { displayName avatarUrl }
      items_aggregate {
        aggregate { count }
      }
      first_item: items(
        order_by: { sort_order: asc }
        limit: 1
      ) {
        restaurant { featured_image_url }
      }
    }
    recommended_restaurant_lists_aggregate(
      where: {
        is_public: { _eq: true }
        is_active: { _eq: true }
        owner_id: { _is_null: false }
      }
    ) {
      aggregate { count }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const rawPage = parseInt(String(req.query.page ?? '0'), 10)
    const rawLimit = parseInt(String(req.query.limit ?? '20'), 10)

    const page = isNaN(rawPage) || rawPage < 0 ? 0 : rawPage
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 50)
    const offset = page * limit

    type RawPublicList = {
      uuid: string
      slug: string
      title: string
      description: string | null
      owner_id: string
      created_at: string
      updated_at: string
      owner: { displayName: string | null; avatarUrl: string | null } | null
      items_aggregate: { aggregate: { count: number } }
      first_item: Array<{ restaurant: { featured_image_url: string | null } | null }>
    }

    type Result = {
      recommended_restaurant_lists: RawPublicList[]
      recommended_restaurant_lists_aggregate: { aggregate: { count: number } }
    }

    const data = await hasuraAdmin<Result>(GET_PUBLIC_LISTS, { limit, offset })

    const lists = (data.recommended_restaurant_lists ?? []).map((list) => ({
      uuid: list.uuid,
      slug: list.slug,
      title: list.title,
      description: list.description,
      owner_id: list.owner_id,
      owner: list.owner,
      items_count: list.items_aggregate.aggregate.count,
      cover_image_url: list.first_item[0]?.restaurant?.featured_image_url ?? null,
      created_at: list.created_at,
      updated_at: list.updated_at,
    }))

    const total = data.recommended_restaurant_lists_aggregate.aggregate.count

    ok(res, {
      lists,
      pagination: {
        page,
        limit,
        total,
        has_more: offset + lists.length < total,
      },
    })
  } catch (error) {
    console.error('[restaurant-lists/get-public-lists]', error)
    fail(res, 'Failed to fetch public lists', 500)
  }
}

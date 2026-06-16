/**
 * GET /v1/restaurant-lists/get-user-public-lists?owner_id=<uuid>&limit=<n>&offset=<n>
 *
 * Public, active lists owned by a user — for profile "Lists" tab. Unauthenticated.
 */
import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { isValidUuid } from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const GET_USER_PUBLIC_LISTS = `
  query GetUserPublicLists($ownerId: uuid!, $limit: Int!, $offset: Int!) {
    recommended_restaurant_lists(
      where: {
        owner_id: { _eq: $ownerId }
        is_public: { _eq: true }
        is_active: { _eq: true }
      }
      order_by: { updated_at: desc }
      limit: $limit
      offset: $offset
    ) {
      uuid slug title description owner_id created_at updated_at
      display_pic
      items_aggregate: recommended_restaurant_list_items_aggregate {
        aggregate { count }
      }
    }
    recommended_restaurant_lists_aggregate(
      where: {
        owner_id: { _eq: $ownerId }
        is_public: { _eq: true }
        is_active: { _eq: true }
      }
    ) {
      aggregate { count }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const ownerId = typeof req.query.owner_id === 'string' ? req.query.owner_id.trim() : ''
    if (!ownerId) return fail(res, 'Missing required param: owner_id', 400)
    if (!isValidUuid(ownerId)) return fail(res, 'Invalid UUID format', 400)

    const rawLimit = parseInt(String(req.query.limit ?? '20'), 10)
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10)
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 50)
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset

    type RawList = {
      uuid: string
      slug: string
      title: string
      description: string | null
      owner_id: string
      created_at: string
      updated_at: string
      display_pic: string | null
      items_aggregate: { aggregate: { count: number } }
    }

    type Result = {
      recommended_restaurant_lists: RawList[]
      recommended_restaurant_lists_aggregate: { aggregate: { count: number } }
    }

    const data = await hasuraAdmin<Result>(GET_USER_PUBLIC_LISTS, {
      ownerId,
      limit,
      offset,
    })

    const lists = (data.recommended_restaurant_lists ?? []).map((list) => ({
      uuid: list.uuid,
      slug: list.slug,
      title: list.title,
      description: list.description,
      owner_id: list.owner_id,
      items_count: list.items_aggregate.aggregate.count,
      display_pic: list.display_pic?.trim() || null,
      cover_image_url: list.display_pic?.trim() || null,
      created_at: list.created_at,
      updated_at: list.updated_at,
    }))

    const total = data.recommended_restaurant_lists_aggregate.aggregate.count

    ok(res, {
      lists,
      meta: {
        total,
        limit,
        offset,
        hasMore: offset + lists.length < total,
      },
    })
  } catch (error) {
    console.error('[restaurant-lists/get-user-public-lists]', error)
    fail(res, 'Failed to fetch user public lists', 500)
  }
}

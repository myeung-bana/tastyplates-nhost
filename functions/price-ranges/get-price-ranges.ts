import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_ALL_PRICE_RANGES = `
  query GetAllPriceRanges($where: restaurant_price_ranges_bool_exp, $order_by: [restaurant_price_ranges_order_by!], $limit: Int, $offset: Int) {
    restaurant_price_ranges(where: $where order_by: $order_by limit: $limit offset: $offset) {
      id name display_name slug symbol description parent_id created_at updated_at
    }
    restaurant_price_ranges_aggregate(where: $where) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const search = url.searchParams.get('search') ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 1000)
    const offset = parseInt(url.searchParams.get('offset') ?? '0')

    if (isNaN(limit) || isNaN(offset)) {
      return fail(res, 'Invalid limit or offset')
    }

    const conditions: Record<string, unknown>[] = []

    if (search) {
      conditions.push({
        _or: [
          { name: { _ilike: `%${search}%` } },
          { display_name: { _ilike: `%${search}%` } },
          { slug: { _ilike: `%${search}%` } },
        ],
      })
    }

    const where = conditions.length > 0 ? { _and: conditions } : {}

    type PriceRangesResult = {
      restaurant_price_ranges: Array<{
        id: number; name: string; display_name: string | null; slug: string
        symbol: string | null; description: string | null; parent_id: number | null
        created_at: string; updated_at: string
      }>
      restaurant_price_ranges_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<PriceRangesResult>(GET_ALL_PRICE_RANGES, {
      where,
      order_by: [{ id: 'asc' }],
      limit,
      offset,
    })

    if (result.errors?.length) {
      console.error('[price-ranges/get-price-ranges]', result.errors)
      return fail(res, 'Failed to fetch price ranges', 500)
    }

    const priceRanges = result.data?.restaurant_price_ranges ?? []
    const total = result.data?.restaurant_price_ranges_aggregate.aggregate.count ?? 0

    ok(res, { priceRanges, meta: { total, limit, offset, hasMore: offset + priceRanges.length < total } })
  } catch (error) {
    console.error('[price-ranges/get-price-ranges]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

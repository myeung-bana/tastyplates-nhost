import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_ALL_PALATES = `
  query GetAllPalates($where: restaurant_palates_bool_exp, $order_by: [restaurant_palates_order_by!], $limit: Int, $offset: Int) {
    restaurant_palates(where: $where order_by: $order_by limit: $limit offset: $offset) {
      id name slug parent_id created_at
    }
    restaurant_palates_aggregate(where: $where) { aggregate { count } }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const search = url.searchParams.get('search') ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 1000)
    const offset = parseInt(url.searchParams.get('offset') ?? '0')
    const parentOnly = url.searchParams.get('parentOnly') === 'true'
    const parentIdParam = url.searchParams.get('parentId')

    if (isNaN(limit) || isNaN(offset)) {
      return fail(res, 'Invalid limit or offset')
    }

    const conditions: Record<string, unknown>[] = []

    if (parentOnly) {
      conditions.push({ parent_id: { _is_null: true } })
    } else if (parentIdParam === 'null') {
      conditions.push({ parent_id: { _is_null: true } })
    } else if (parentIdParam !== null) {
      const pid = parseInt(parentIdParam)
      if (!isNaN(pid)) conditions.push({ parent_id: { _eq: pid } })
    }

    if (search) {
      conditions.push({ _or: [{ name: { _ilike: `%${search}%` } }, { slug: { _ilike: `%${search}%` } }] })
    }

    const where = conditions.length > 0 ? { _and: conditions } : {}

    type PalatesResult = {
      restaurant_palates: Array<{ id: number; name: string; slug: string; parent_id: number | null; created_at: string }>
      restaurant_palates_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<PalatesResult>(GET_ALL_PALATES, {
      where,
      order_by: [{ name: 'asc' }],
      limit,
      offset,
    })

    if (result.errors?.length) {
      console.error('[palates/get-palates]', result.errors)
      return fail(res, 'Failed to fetch palates', 500)
    }

    const palates = result.data?.restaurant_palates ?? []
    const total = result.data?.restaurant_palates_aggregate.aggregate.count ?? 0

    ok(res, { palates, meta: { total, limit, offset, hasMore: offset + palates.length < total } })
  } catch (error) {
    console.error('[palates/get-palates]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

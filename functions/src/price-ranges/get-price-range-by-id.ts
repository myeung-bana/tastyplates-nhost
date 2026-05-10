import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_PRICE_RANGE_BY_ID = `
  query GetPriceRangeById($id: Int!) {
    restaurant_price_ranges_by_pk(id: $id) {
      id name display_name slug symbol description parent_id created_at updated_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const idParam = url.searchParams.get('id')

    if (!idParam) return fail(res, 'Missing required param: id', 400)

    const id = parseInt(idParam)
    if (isNaN(id)) return fail(res, 'Invalid id: must be an integer', 400)

    type Result = {
      restaurant_price_ranges_by_pk: {
        id: number; name: string; display_name: string | null; slug: string
        symbol: string | null; description: string | null; parent_id: number | null
        created_at: string; updated_at: string
      } | null
    }
    const result = await hasuraQuery<Result>(GET_PRICE_RANGE_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[price-ranges/get-price-range-by-id]', result.errors)
      return fail(res, 'Failed to fetch price range', 500)
    }

    const priceRange = result.data?.restaurant_price_ranges_by_pk
    if (!priceRange) return fail(res, 'Price range not found', 404)

    ok(res, { priceRange })
  } catch (error) {
    console.error('[price-ranges/get-price-range-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

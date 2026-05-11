import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_PALATE_BY_ID = `
  query GetPalateById($id: Int!) {
    restaurant_palates_by_pk(id: $id) { id name slug parent_id created_at }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const idParam = url.searchParams.get('id')

    if (!idParam) return fail(res, 'Missing required param: id', 400)

    const id = parseInt(idParam)
    if (isNaN(id)) return fail(res, 'Invalid id: must be an integer', 400)

    type Result = { restaurant_palates_by_pk: { id: number; name: string; slug: string; parent_id: number | null; created_at: string } | null }
    const result = await hasuraQuery<Result>(GET_PALATE_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[palates/get-palate-by-id]', result.errors)
      return fail(res, 'Failed to fetch palate', 500)
    }

    const palate = result.data?.restaurant_palates_by_pk
    if (!palate) return fail(res, 'Palate not found', 404)

    ok(res, { palate })
  } catch (error) {
    console.error('[palates/get-palate-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

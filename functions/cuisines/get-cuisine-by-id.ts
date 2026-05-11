import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_CUISINE_BY_ID = `
  query GetCuisineById($id: Int!) {
    restaurant_cuisines_by_pk(id: $id) { id name slug description parent_id flag_url created_at }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const idParam = url.searchParams.get('id')

    if (!idParam) return fail(res, 'Missing required param: id', 400)

    const id = parseInt(idParam)
    if (isNaN(id)) return fail(res, 'Invalid id: must be an integer', 400)

    type Result = { restaurant_cuisines_by_pk: { id: number; name: string; slug: string; description: string | null; parent_id: number | null; flag_url: string | null; created_at: string } | null }
    const result = await hasuraQuery<Result>(GET_CUISINE_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[cuisines/get-cuisine-by-id]', result.errors)
      return fail(res, 'Failed to fetch cuisine', 500)
    }

    const cuisine = result.data?.restaurant_cuisines_by_pk
    if (!cuisine) return fail(res, 'Cuisine not found', 404)

    ok(res, { cuisine })
  } catch (error) {
    console.error('[cuisines/get-cuisine-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

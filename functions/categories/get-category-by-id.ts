import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_CATEGORY_BY_ID = `
  query GetCategoryById($id: Int!) {
    restaurant_categories_by_pk(id: $id) { id name slug description parent_id created_at }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const idParam = url.searchParams.get('id')

    if (!idParam) return fail(res, 'Missing required param: id', 400)

    const id = parseInt(idParam)
    if (isNaN(id)) return fail(res, 'Invalid id: must be an integer', 400)

    type Result = { restaurant_categories_by_pk: { id: number; name: string; slug: string; description: string | null; parent_id: number | null; created_at: string } | null }
    const result = await hasuraQuery<Result>(GET_CATEGORY_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[categories/get-category-by-id]', result.errors)
      return fail(res, 'Failed to fetch category', 500)
    }

    const category = result.data?.restaurant_categories_by_pk
    if (!category) return fail(res, 'Category not found', 404)

    ok(res, { category })
  } catch (error) {
    console.error('[categories/get-category-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

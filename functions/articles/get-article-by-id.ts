import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_ARTICLE_BY_ID = `
  query GetArticleById($id: Int!) {
    articles_by_pk(id: $id) {
      id uuid slug title excerpt content category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at meta_title meta_description meta_keywords view_count gallery_images
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

    type Result = { articles_by_pk: unknown | null }
    const result = await hasuraQuery<Result>(GET_ARTICLE_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[articles/get-article-by-id]', result.errors)
      return fail(res, 'Failed to fetch article', 500)
    }

    const article = result.data?.articles_by_pk
    if (!article) return fail(res, 'Article not found', 404)

    ok(res, { article })
  } catch (error) {
    console.error('[articles/get-article-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

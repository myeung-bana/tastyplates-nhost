import type { Request, Response } from 'express'
import { enrichArticleRestaurantAssociations } from '../_lib/articleRestaurantAssociations'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const ARTICLE_RESTAURANT_ASSOCIATIONS = `
      article_restaurant_associations(order_by: { display_order: asc }) {
        id
        article_id
        restaurant_id
        display_order
        created_at
      }
`

/**
 * Published, non-deleted articles only — aligned with slug route (`articlev2.md` §9 parity).
 * Uses `articles` filter instead of `articles_by_pk` so drafts are not exposed by numeric id.
 */
const GET_ARTICLE_BY_ID = `
  query GetArticleByIdPublished($id: Int!) {
    articles(
      where: {
        id: { _eq: $id }
        deleted_at: { _is_null: true }
        status: { _eq: "published" }
      }
      limit: 1
    ) {
      id uuid slug title excerpt content category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at meta_title meta_description meta_keywords view_count gallery_images
      author_profile { id displayName avatarUrl email }
${ARTICLE_RESTAURANT_ASSOCIATIONS}
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

    type Result = { articles: unknown[] }
    const result = await hasuraQuery<Result>(GET_ARTICLE_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[articles/get-article-by-id]', result.errors)
      return fail(res, 'Failed to fetch article', 500)
    }

    const article = result.data?.articles?.[0]
    if (!article) return fail(res, 'Article not found', 404)

    const { article: enriched, restaurantEnrichment } =
      await enrichArticleRestaurantAssociations(article as Record<string, unknown>)
    ok(res, {
      article: enriched,
      articleMeta: { restaurantEnrichment },
    })
  } catch (error) {
    console.error('[articles/get-article-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

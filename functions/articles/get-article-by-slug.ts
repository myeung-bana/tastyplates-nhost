import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_ARTICLE_BY_SLUG = `
  query GetArticleBySlugDetail($slug: String!) {
    articles(where: { slug: { _eq: $slug } deleted_at: { _is_null: true } status: { _eq: "published" } } limit: 1) {
      id uuid slug title excerpt content category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at meta_title meta_description meta_keywords view_count gallery_images
      author_profile { id displayName avatarUrl email }
    }
  }
`

const GET_ARTICLE_BY_SLUG_ILIKE = `
  query GetArticleBySlugIlike($slug: String!) {
    articles(where: { slug: { _ilike: $slug } deleted_at: { _is_null: true } status: { _eq: "published" } } limit: 1) {
      id uuid slug title excerpt content category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at meta_title meta_description meta_keywords view_count gallery_images
      author_profile { id displayName avatarUrl email }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const slug = url.searchParams.get('slug')

    if (!slug) return fail(res, 'Missing required param: slug', 400)

    type ArticlesResult = { articles: unknown[] }
    let result = await hasuraQuery<ArticlesResult>(GET_ARTICLE_BY_SLUG, { slug })

    if (result.errors?.length) {
      console.error('[articles/get-article-by-slug]', result.errors)
      return fail(res, 'Failed to fetch article', 500)
    }

    let article = result.data?.articles?.[0]

    if (!article) {
      result = await hasuraQuery<ArticlesResult>(GET_ARTICLE_BY_SLUG_ILIKE, { slug })
      if (result.errors?.length) {
        console.error('[articles/get-article-by-slug ilike]', result.errors)
        return fail(res, 'Failed to fetch article', 500)
      }
      article = result.data?.articles?.[0]
    }

    if (!article) return fail(res, 'Article not found', 404)

    ok(res, { article })
  } catch (error) {
    console.error('[articles/get-article-by-slug]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

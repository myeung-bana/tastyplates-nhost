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

const ARTICLE_CORE_FIELDS = `
      id uuid slug title excerpt content category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at meta_title meta_description meta_keywords view_count gallery_images
      author_profile { id displayName avatarUrl email }
`

const GET_ARTICLE_BY_SLUG = `
  query GetArticleBySlugDetail($slug: String!) {
    articles(where: { slug: { _eq: $slug } deleted_at: { _is_null: true } status: { _eq: "published" } } limit: 1) {
${ARTICLE_CORE_FIELDS}
${ARTICLE_RESTAURANT_ASSOCIATIONS}
    }
  }
`

const GET_ARTICLE_BY_SLUG_SIMPLE = `
  query GetArticleBySlugSimple($slug: String!) {
    articles(where: { slug: { _eq: $slug } deleted_at: { _is_null: true } status: { _eq: "published" } } limit: 1) {
${ARTICLE_CORE_FIELDS}
    }
  }
`

const GET_ARTICLE_BY_SLUG_ILIKE = `
  query GetArticleBySlugIlike($slug: String!) {
    articles(where: { slug: { _ilike: $slug } deleted_at: { _is_null: true } status: { _eq: "published" } } limit: 1) {
${ARTICLE_CORE_FIELDS}
${ARTICLE_RESTAURANT_ASSOCIATIONS}
    }
  }
`

const GET_ARTICLE_BY_SLUG_SIMPLE_ILIKE = `
  query GetArticleBySlugSimpleIlike($slug: String!) {
    articles(where: { slug: { _ilike: $slug } deleted_at: { _is_null: true } status: { _eq: "published" } } limit: 1) {
${ARTICLE_CORE_FIELDS}
    }
  }
`

type ArticlesResult = { articles: unknown[] }

/** `_ilike` treats `_` and `%` as wildcards — skip CI fallback for those slugs (tastyplates-v2). */
function isSafeForIlikeExactSlug(slug: string): boolean {
  return slug.length > 0 && !slug.includes('%') && !slug.includes('_')
}

/** Detail query first; on GraphQL error, simple query without associations (`articlev2.md` §4.1). */
async function queryArticle(
  query: string,
  variables: { slug: string },
): Promise<{ data: ArticlesResult | null; errors?: Array<{ message: string }> }> {
  return hasuraQuery<ArticlesResult>(query, variables)
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const slug = url.searchParams.get('slug')

    if (!slug) return fail(res, 'Missing required param: slug', 400)

    let result = await queryArticle(GET_ARTICLE_BY_SLUG, { slug })

    if (result.errors?.length) {
      console.warn(
        '[articles/get-article-by-slug] detail query failed, trying simple:',
        result.errors[0]?.message,
      )
      result = await queryArticle(GET_ARTICLE_BY_SLUG_SIMPLE, { slug })
    }

    if (result.errors?.length) {
      console.error('[articles/get-article-by-slug]', result.errors)
      return fail(res, 'Failed to fetch article', 500)
    }

    let article = result.data?.articles?.[0]

    if (!article && isSafeForIlikeExactSlug(slug)) {
      result = await queryArticle(GET_ARTICLE_BY_SLUG_ILIKE, { slug })
      if (result.errors?.length) {
        console.warn(
          '[articles/get-article-by-slug] detail ilike failed, trying simple ilike:',
          result.errors[0]?.message,
        )
        result = await queryArticle(GET_ARTICLE_BY_SLUG_SIMPLE_ILIKE, { slug })
      }

      if (result.errors?.length) {
        console.error('[articles/get-article-by-slug ilike]', result.errors)
        return fail(res, 'Failed to fetch article', 500)
      }

      article = result.data?.articles?.[0]
    }

    if (!article) return fail(res, 'Article not found', 404)

    const { article: enriched, restaurantEnrichment } =
      await enrichArticleRestaurantAssociations(article as Record<string, unknown>)
    ok(res, {
      article: enriched,
      articleMeta: { restaurantEnrichment },
    })
  } catch (error) {
    console.error('[articles/get-article-by-slug]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

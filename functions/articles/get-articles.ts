import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_RESTAURANT_LOCATION_BY_SLUG = `
  query GetRestaurantLocationBySlug($slug: String!) {
    restaurant_locations(where: { slug: { _eq: $slug } is_active: { _eq: true } } limit: 1) {
      id slug type parent_id
    }
  }
`

const GET_CHILD_RESTAURANT_LOCATION_IDS = `
  query GetChildRestaurantLocationIds($parentId: Int!) {
    restaurant_locations(where: { parent_id: { _eq: $parentId } is_active: { _eq: true } }) { id }
  }
`

const ARTICLE_LOCATION_FILTER = `
  _and: [
    { status: { _eq: "published" } }
    { deleted_at: { _is_null: true } }
    {
      article_restaurant_location_associations: {
        location_id: { _in: $locationIds }
      }
    }
  ]
`

const GET_ARTICLES_FOR_LOCATIONS = `
  query GetArticlesForLocations($locationIds: [Int!]!, $limit: Int!, $offset: Int!) {
    articles(
      where: { ${ARTICLE_LOCATION_FILTER.trim()} }
      order_by: { published_at: desc }
      limit: $limit offset: $offset
    ) {
      id uuid slug title excerpt category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at view_count
    }
    articles_aggregate(
      where: { ${ARTICLE_LOCATION_FILTER.trim()} }
    ) { aggregate { count } }
  }
`

const GET_ARTICLES_FOR_LOCATIONS_FALLBACK = `
  query GetArticlesForLocationsFallback($locationIds: [Int!]!, $limit: Int!, $offset: Int!) {
    articles(
      where: { ${ARTICLE_LOCATION_FILTER.trim()} }
      order_by: { published_at: desc }
      limit: $limit offset: $offset
    ) {
      id uuid slug title excerpt category featured_image_url
      reading_time_minutes published_at view_count
    }
    articles_aggregate(
      where: { ${ARTICLE_LOCATION_FILTER.trim()} }
    ) { aggregate { count } }
  }
`

const GET_ARTICLES = `
  query GetArticles($limit: Int!, $offset: Int!) {
    articles(
      where: { deleted_at: { _is_null: true } status: { _eq: "published" } }
      order_by: { published_at: desc }
      limit: $limit offset: $offset
    ) {
      id uuid slug title excerpt category featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at view_count
    }
    articles_aggregate(
      where: { deleted_at: { _is_null: true } status: { _eq: "published" } }
    ) { aggregate { count } }
  }
`

const GET_ARTICLES_FALLBACK = `
  query GetArticlesFallback($limit: Int!, $offset: Int!) {
    articles(
      where: { deleted_at: { _is_null: true } status: { _eq: "published" } }
      order_by: { published_at: desc }
      limit: $limit offset: $offset
    ) {
      id uuid slug title excerpt category featured_image_url
      reading_time_minutes published_at view_count
    }
    articles_aggregate(
      where: { deleted_at: { _is_null: true } status: { _eq: "published" } }
    ) { aggregate { count } }
  }
`

interface LocationRow { id: number; slug: string; type: string; parent_id: number | null }

async function resolveArticleLocationContext(locationSlug: string): Promise<{ cityIds: number[]; countryIds: number[] } | null> {
  type LocResult = { restaurant_locations: LocationRow[] }
  const locResult = await hasuraQuery<LocResult>(GET_RESTAURANT_LOCATION_BY_SLUG, { slug: locationSlug })
  const location = locResult.data?.restaurant_locations?.[0]
  if (!location) return null

  if (location.type === 'city') {
    const countryIds = location.parent_id ? [location.parent_id] : []
    return { cityIds: [location.id], countryIds }
  }

  if (location.type === 'country') {
    type ChildResult = { restaurant_locations: Array<{ id: number }> }
    const childResult = await hasuraQuery<ChildResult>(GET_CHILD_RESTAURANT_LOCATION_IDS, { parentId: location.id })
    const cityIds = childResult.data?.restaurant_locations?.map(r => r.id) ?? []
    return { cityIds, countryIds: [location.id] }
  }

  return null
}

async function fetchArticlesForLocations(locationIds: number[], limit: number, offset: number) {
  type ArticlesResult = { articles: unknown[]; articles_aggregate: { aggregate: { count: number } } }
  const result = await hasuraQuery<ArticlesResult>(GET_ARTICLES_FOR_LOCATIONS, { locationIds, limit, offset })
  if (result.errors?.length) {
    const fallback = await hasuraQuery<ArticlesResult>(GET_ARTICLES_FOR_LOCATIONS_FALLBACK, { locationIds, limit, offset })
    return fallback
  }
  return result
}

async function mergeCityThenCountryArticles(
  cityIds: number[],
  countryIds: number[],
  limit: number,
  offset: number,
) {
  if (cityIds.length > 0) {
    const cityResult = await fetchArticlesForLocations(cityIds, limit, offset)
    const articles = cityResult.data?.articles ?? []
    const total = cityResult.data?.articles_aggregate.aggregate.count ?? 0
    if (articles.length > 0) return { articles, total }
  }

  if (countryIds.length > 0) {
    const countryResult = await fetchArticlesForLocations(countryIds, limit, offset)
    return {
      articles: countryResult.data?.articles ?? [],
      total: countryResult.data?.articles_aggregate.aggregate.count ?? 0,
    }
  }

  return { articles: [], total: 0 }
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '4'), 50)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0
    const locationSlug = url.searchParams.get('location_slug') ?? undefined

    if (isNaN(limit)) return fail(res, 'Invalid limit', 400)

    let articles: unknown[]
    let total: number

    if (locationSlug) {
      const context = await resolveArticleLocationContext(locationSlug)
      if (!context) {
        articles = []
        total = 0
      } else {
        const merged = await mergeCityThenCountryArticles(context.cityIds, context.countryIds, limit, offset)
        articles = merged.articles
        total = merged.total
      }
    } else {
      type ArticlesResult = { articles: unknown[]; articles_aggregate: { aggregate: { count: number } } }
      let result = await hasuraQuery<ArticlesResult>(GET_ARTICLES, { limit, offset })
      if (result.errors?.length) {
        result = await hasuraQuery<ArticlesResult>(GET_ARTICLES_FALLBACK, { limit, offset })
        if (result.errors?.length) {
          console.error('[articles/get-articles]', result.errors)
          return fail(res, 'Failed to fetch articles', 500)
        }
      }
      articles = result.data?.articles ?? []
      total = result.data?.articles_aggregate.aggregate.count ?? 0
    }

    ok(res, { articles, meta: { limit, offset, hasMore: offset + articles.length < total } })
  } catch (error) {
    console.error('[articles/get-articles]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

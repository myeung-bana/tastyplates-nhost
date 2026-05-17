import { hasuraQuery } from './hasura'

/**
 * Hasura often has no object relationship from `article_restaurant_associations` → `restaurants`.
 * Fetch associations on the article, then batch-load restaurants by id (same approach as tastyplates-v2).
 */
const GET_RESTAURANTS_BY_IDS_FOR_ARTICLE = `
  query GetRestaurantsByIdsForArticle($ids: [Int!]!) {
    restaurants(where: { id: { _in: $ids } }) {
      id
      title
      slug
      featured_image_url
      listing_street
      address
      average_rating
      ratings_count
      content
    }
  }
`

/** Returned alongside article from `get-article-by-*` (`articlev2.md` — enrichment telemetry). */
export type RestaurantEnrichmentStatus = 'skipped' | 'ok' | 'partial' | 'failed'

export interface EnrichArticleAssociationsResult<T> {
  article: T
  restaurantEnrichment: RestaurantEnrichmentStatus
}

function parseIntId(id: unknown): number | null {
  if (id == null) return null
  if (typeof id === 'number' && Number.isFinite(id)) return Math.trunc(id)
  const n = parseInt(String(id), 10)
  return Number.isNaN(n) ? null : n
}

export async function enrichArticleRestaurantAssociations<T extends Record<string, unknown>>(
  article: T | null | undefined,
): Promise<EnrichArticleAssociationsResult<T | null | undefined>> {
  if (article == null) {
    return { article, restaurantEnrichment: 'skipped' }
  }

  const assocs = article.article_restaurant_associations
  if (!Array.isArray(assocs) || assocs.length === 0) {
    return { article, restaurantEnrichment: 'skipped' }
  }

  const ids = [
    ...new Set(
      assocs
        .map((a) => parseIntId((a as Record<string, unknown>).restaurant_id))
        .filter((n): n is number => n != null),
    ),
  ]

  if (ids.length === 0) {
    return { article, restaurantEnrichment: 'skipped' }
  }

  const result = await hasuraQuery<{ restaurants: Array<Record<string, unknown>> }>(
    GET_RESTAURANTS_BY_IDS_FOR_ARTICLE,
    { ids },
  )

  if (result.errors?.length || !result.data?.restaurants) {
    console.warn(
      '[enrichArticleRestaurantAssociations]',
      result.errors?.[0]?.message ?? 'missing restaurants batch',
    )
    return { article, restaurantEnrichment: 'failed' }
  }

  const byId = new Map<number, Record<string, unknown>>()
  for (const r of result.data.restaurants) {
    const pk = parseIntId(r.id)
    if (pk != null) byId.set(pk, r)
  }

  const merged = assocs.map((a) => {
    const o = a as Record<string, unknown>
    const rid = parseIntId(o.restaurant_id)
    const restaurant = rid != null ? byId.get(rid) : undefined
    if (!restaurant) return o
    return { ...o, restaurant }
  })

  let expectedWithId = 0
  let matched = 0
  for (const row of merged) {
    const o = row as Record<string, unknown>
    const rid = parseIntId(o.restaurant_id)
    if (rid == null) continue
    expectedWithId++
    if (o.restaurant != null && typeof o.restaurant === 'object') matched++
  }

  let restaurantEnrichment: RestaurantEnrichmentStatus
  if (expectedWithId === 0) {
    restaurantEnrichment = 'skipped'
  } else if (matched === expectedWithId) {
    restaurantEnrichment = 'ok'
  } else {
    restaurantEnrichment = 'partial'
  }

  return {
    article: { ...article, article_restaurant_associations: merged },
    restaurantEnrichment,
  }
}

import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import {
  safeEnrichReviewRows,
  isValidUuid,
  REVIEW_AUTHOR_GRAPHQL_NESTED,
} from '../_lib/review-enrichment'
import { ok, fail } from '../_lib/respond'

const REVIEW_ROW_FIELDS = `
  id title content rating images palates hashtags mentions recognitions likes_count replies_count
  status created_at published_at author_id restaurant_uuid is_pinned is_featured views_count updated_at
  ${REVIEW_AUTHOR_GRAPHQL_NESTED}
`

const REVIEW_WHERE = `
  restaurant_uuid: { _eq: $restaurantUuid }
  deleted_at: { _is_null: true }
  parent_review_id: { _is_null: true }
`

const GET_REVIEWS_ALL = `
  query GetReviewsByRestaurant($restaurantUuid: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { ${REVIEW_WHERE} }
      order_by: [{ is_pinned: desc }, { created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) { ${REVIEW_ROW_FIELDS} }
    restaurant_reviews_aggregate(where: { ${REVIEW_WHERE} }) { aggregate { count } }
  }
`

const GET_REVIEWS_DATE_ASC = `
  query GetReviewsByRestaurantDateAsc($restaurantUuid: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { ${REVIEW_WHERE} }
      order_by: [{ created_at: asc }, { id: asc }]
      limit: $limit offset: $offset
    ) { ${REVIEW_ROW_FIELDS} }
    restaurant_reviews_aggregate(where: { ${REVIEW_WHERE} }) { aggregate { count } }
  }
`

const GET_REVIEWS_DATE_DESC = `
  query GetReviewsByRestaurantDateDesc($restaurantUuid: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { ${REVIEW_WHERE} }
      order_by: [{ created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) { ${REVIEW_ROW_FIELDS} }
    restaurant_reviews_aggregate(where: { ${REVIEW_WHERE} }) { aggregate { count } }
  }
`

const GET_REVIEWS_HIGHEST_RATED = `
  query GetReviewsByRestaurantHighestRated($restaurantUuid: uuid!, $limit: Int, $offset: Int) {
    restaurant_reviews(
      where: { ${REVIEW_WHERE} }
      order_by: [{ rating: desc }, { created_at: desc }, { id: desc }]
      limit: $limit offset: $offset
    ) { ${REVIEW_ROW_FIELDS} }
    restaurant_reviews_aggregate(where: { ${REVIEW_WHERE} }) { aggregate { count } }
  }
`

type SortMode = 'all' | 'asc' | 'desc' | 'highest'

function parseSortParam(raw: string | null): SortMode {
  const value = raw?.trim().toLowerCase()
  if (value === 'asc' || value === 'desc' || value === 'highest') return value
  return 'all'
}

const QUERY_BY_SORT: Record<SortMode, string> = {
  all: GET_REVIEWS_ALL,
  asc: GET_REVIEWS_DATE_ASC,
  desc: GET_REVIEWS_DATE_DESC,
  highest: GET_REVIEWS_HIGHEST_RATED,
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const restaurantUuid = url.searchParams.get('restaurant_uuid')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0') || 0
    const sort = parseSortParam(url.searchParams.get('sort'))

    if (!restaurantUuid) return fail(res, 'Missing required param: restaurant_uuid', 400)
    if (!isValidUuid(restaurantUuid)) return fail(res, 'Invalid UUID format', 400)

    type Result = {
      restaurant_reviews: Array<Record<string, unknown>>
      restaurant_reviews_aggregate: { aggregate: { count: number } }
    }

    const result = await hasuraQuery<Result>(QUERY_BY_SORT[sort], {
      restaurantUuid,
      limit,
      offset,
    })

    if (result.errors?.length) {
      console.error('[restaurant-reviews/get-reviews-by-restaurant]', result.errors)
      return fail(res, 'Failed to fetch reviews', 500)
    }

    const reviewsRaw = result.data?.restaurant_reviews ?? []
    const total = result.data?.restaurant_reviews_aggregate.aggregate.count ?? 0

    const reviews = await safeEnrichReviewRows(reviewsRaw)

    ok(res, { reviews, meta: { total, limit, offset, hasMore: offset + reviews.length < total } })
  } catch (error) {
    console.error('[restaurant-reviews/get-reviews-by-restaurant]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import { hasuraAdmin } from './hasura'

const GET_ALL_REVIEWS = `
  query GetAllReviewsV2($limit: Int, $offset: Int, $where: restaurant_reviews_bool_exp, $order_by: [restaurant_reviews_order_by!]) {
    restaurant_reviews(limit: $limit, offset: $offset, where: $where, order_by: $order_by) {
      id author_id content created_at deleted_at hashtags images is_featured is_pinned likes_count mentions palates parent_review_id published_at rating recognitions replies_count restaurant_uuid status title updated_at views_count
    }
    restaurant_reviews_aggregate(where: $where) { aggregate { count } }
  }
`

const GET_REVIEW_BY_ID = `
  query GetReviewByIdV2($id: uuid!) {
    restaurant_reviews_by_pk(id: $id) {
      id author_id content created_at deleted_at hashtags images is_featured is_pinned likes_count mentions palates parent_review_id published_at rating recognitions replies_count restaurant_uuid status title updated_at views_count
    }
  }
`

const UPDATE_REVIEW = `
  mutation UpdateReviewV2($id: uuid!, $changes: restaurant_reviews_set_input!) {
    update_restaurant_reviews_by_pk(pk_columns: { id: $id }, _set: $changes) {
      id author_id content status title rating is_featured is_pinned updated_at restaurant_uuid
    }
  }
`

export async function listReviews(params: URLSearchParams) {
  const limit = Math.max(1, Math.min(parseInt(params.get('limit') ?? '100', 10) || 100, 100))
  const offset = Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0)
  const status = params.get('status')
  const search = params.get('search')
  const restaurant_uuid = params.get('restaurant_uuid')
  const is_featured = params.get('is_featured')
  const is_pinned = params.get('is_pinned')

  const where: Record<string, unknown> = {
    deleted_at: { _is_null: true },
    parent_review_id: { _is_null: true },
  }
  if (status) where.status = { _eq: status }
  if (restaurant_uuid) where.restaurant_uuid = { _eq: restaurant_uuid }
  if (is_featured != null) where.is_featured = { _eq: is_featured === 'true' }
  if (is_pinned != null) where.is_pinned = { _eq: is_pinned === 'true' }
  if (search) {
    where._or = [
      { title: { _ilike: `%${search}%` } },
      { content: { _ilike: `%${search}%` } },
    ]
  }

  const data = await hasuraAdmin<{
    restaurant_reviews: Array<Record<string, unknown>>
    restaurant_reviews_aggregate: { aggregate: { count: number } | null }
  }>(GET_ALL_REVIEWS, {
    limit,
    offset,
    where,
    order_by: { created_at: 'desc' },
  })

  const reviews = data.restaurant_reviews ?? []
  const total = data.restaurant_reviews_aggregate?.aggregate?.count ?? reviews.length

  return {
    success: true,
    data: reviews,
    meta: { total, limit, offset, hasMore: offset + limit < total, fetchedAt: new Date().toISOString() },
  }
}

export async function getReviewById(id: string) {
  const data = await hasuraAdmin<{ restaurant_reviews_by_pk: Record<string, unknown> | null }>(
    GET_REVIEW_BY_ID,
    { id },
  )
  const review = data.restaurant_reviews_by_pk
  if (!review) return null
  return { data: review, meta: { fetchedAt: new Date().toISOString() } }
}

export async function updateReview(body: Record<string, unknown>) {
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) throw new Error('Review id is required')

  const changes: Record<string, unknown> = {}
  for (const key of ['status', 'content', 'title', 'rating', 'is_featured', 'is_pinned'] as const) {
    if (body[key] !== undefined) changes[key] = body[key]
  }

  const data = await hasuraAdmin<{ update_restaurant_reviews_by_pk: Record<string, unknown> | null }>(
    UPDATE_REVIEW,
    { id, changes },
  )
  if (!data.update_restaurant_reviews_by_pk) throw new Error('Review not found or update failed')
  return { success: true, data: data.update_restaurant_reviews_by_pk }
}

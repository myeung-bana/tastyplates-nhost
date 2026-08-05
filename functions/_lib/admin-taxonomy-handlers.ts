import { hasuraAdmin } from './hasura'

export async function listCuisines(params: URLSearchParams) {
  const parentOnly = params.get('parentOnly') === 'true'
  const parentIdParam = params.get('parentId')
  const search = params.get('search')

  const where: Record<string, unknown> = {}
  if (parentOnly || parentIdParam === 'null') where.parent_id = { _is_null: true }
  else if (parentIdParam) where.parent_id = { _eq: parseInt(parentIdParam, 10) }
  if (search) {
    where._or = [
      { name: { _ilike: `%${search}%` } },
      { slug: { _ilike: `%${search}%` } },
    ]
  }

  const query = parentOnly
    ? `query { restaurant_cuisines(where: { parent_id: { _is_null: true } }, order_by: { name: asc }) { id name slug description parent_id flag_url created_at } }`
    : `query GetCuisines($where: restaurant_cuisines_bool_exp, $order_by: [restaurant_cuisines_order_by!]) {
        restaurant_cuisines(where: $where, order_by: $order_by) { id name slug description parent_id flag_url created_at }
      }`

  const variables = parentOnly
    ? undefined
    : {
        where: Object.keys(where).length > 0 ? where : undefined,
        order_by: { name: 'asc' },
      }

  const data = await hasuraAdmin<{ restaurant_cuisines: Array<Record<string, unknown>> }>(
    query,
    variables,
  )
  const cuisines = data.restaurant_cuisines ?? []
  return { data: cuisines, meta: { total: cuisines.length } }
}

export async function listCategories(params: URLSearchParams) {
  const search = params.get('search')
  const where: Record<string, unknown> = {}
  if (search) {
    where._or = [
      { name: { _ilike: `%${search}%` } },
      { slug: { _ilike: `%${search}%` } },
    ]
  }

  const data = await hasuraAdmin<{ restaurant_categories: Array<Record<string, unknown>> }>(
    `query GetCategories($where: restaurant_categories_bool_exp, $order_by: [restaurant_categories_order_by!]) {
      restaurant_categories(where: $where, order_by: $order_by) { id name slug description parent_id created_at }
    }`,
    {
      where: Object.keys(where).length > 0 ? where : undefined,
      order_by: { name: 'asc' },
    },
  )
  const categories = data.restaurant_categories ?? []
  return { data: categories, meta: { total: categories.length } }
}

export async function listPriceRanges() {
  const data = await hasuraAdmin<{ restaurant_price_ranges: Array<Record<string, unknown>> }>(
    `query { restaurant_price_ranges(order_by: { id: asc }) { id name slug symbol display_name created_at } }`,
  )
  const priceRanges = data.restaurant_price_ranges ?? []
  return { data: priceRanges, meta: { total: priceRanges.length } }
}

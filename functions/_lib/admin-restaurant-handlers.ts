import { hasuraAdmin } from './hasura'
import { fetchPlaceDetails, resolveGooglePlaceId, searchPlaces } from './google-places-admin'
import {
  matchesQualityFilter,
  normalizeQualityFilter,
  type RestaurantQualityFields,
  type RestaurantQualityFilter,
} from './restaurant-quality-admin'

const GET_RESTAURANTS_LIST = `
  query GetRestaurantsListV2($limit: Int, $offset: Int, $where: restaurants_bool_exp, $order_by: [restaurants_order_by!], $where_publish: restaurants_bool_exp, $where_draft: restaurants_bool_exp, $where_private: restaurants_bool_exp) {
    restaurants(limit: $limit, offset: $offset, where: $where, order_by: $order_by) {
      id uuid title slug status price_range price_range_id average_rating ratings_count listing_street phone latitude longitude featured_image_url address uploaded_images cuisines is_main_location branch_group_id created_at updated_at published_at
    }
    restaurants_aggregate(where: $where) { aggregate { count } }
    publish: restaurants_aggregate(where: $where_publish) { aggregate { count } }
    draft: restaurants_aggregate(where: $where_draft) { aggregate { count } }
    private: restaurants_aggregate(where: $where_private) { aggregate { count } }
  }
`

const GET_RESTAURANT_BY_UUID = `
  query GetRestaurantByUuidV2($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      id uuid title slug status content price_range price_range_id average_rating ratings_count listing_street phone opening_hours menu_url longitude latitude google_place_id google_zoom featured_image_url address uploaded_images cuisines palates categories is_main_location branch_group_id created_at updated_at published_at
    }
  }
`

const GET_RESTAURANT_BRANCHES_BULK = `
  query GetRestaurantBranchesBulk($restaurant_ids: [Int!]!) {
    restaurant_branches(where: { parent_restaurant_id: { _in: $restaurant_ids } }) {
      parent_restaurant_id branch_restaurant_id
      restaurant { id uuid title slug status listing_street phone latitude longitude featured_image_url address cuisines created_at updated_at published_at }
    }
  }
`

const GET_RESTAURANT_BRANCHES = `
  query GetRestaurantBranches($parent_restaurant_id: Int!) {
    restaurant_branches(where: { parent_restaurant_id: { _eq: $parent_restaurant_id } }) {
      restaurant { id uuid title slug listing_street address featured_image_url }
    }
  }
`

const GET_RESTAURANT_PARENTS_BULK = `
  query GetRestaurantParentsBulk($restaurant_ids: [Int!]!) {
    restaurant_branches(where: { branch_restaurant_id: { _in: $restaurant_ids } }) {
      restaurantByParentRestaurantId { id uuid title slug listing_street address featured_image_url }
    }
  }
`

const CREATE_RESTAURANT = `
  mutation CreateRestaurantV2($object: restaurants_insert_input!) {
    insert_restaurants_one(object: $object) {
      id uuid title slug status cuisines categories google_place_id created_at
    }
  }
`

const UPDATE_RESTAURANT = `
  mutation UpdateRestaurantV2($id: Int!, $changes: restaurants_set_input!) {
    update_restaurants_by_pk(pk_columns: { id: $id }, _set: $changes) {
      id uuid title slug status updated_at
    }
  }
`

function transformRestaurant(restaurant: Record<string, unknown>) {
  return {
    ...restaurant,
    cuisines: Array.isArray(restaurant.cuisines) ? restaurant.cuisines : [],
  }
}

async function mergeBranchesForList(restaurants: Record<string, unknown>[]) {
  if (restaurants.length === 0) return restaurants.map((r) => ({ ...r, branches: [] }))
  const ids = restaurants.map((r) => r.id as number).filter((id) => typeof id === 'number')
  if (ids.length === 0) return restaurants.map((r) => ({ ...r, branches: [] }))

  const data = await hasuraAdmin<{
    restaurant_branches: Array<{ parent_restaurant_id: number; restaurant: Record<string, unknown> }>
  }>(GET_RESTAURANT_BRANCHES_BULK, { restaurant_ids: ids })

  const branchesByParent = new Map<number, unknown[]>()
  for (const branch of data.restaurant_branches ?? []) {
    const parentId = branch.parent_restaurant_id
    if (!parentId || !branch.restaurant) continue
    if (!branchesByParent.has(parentId)) branchesByParent.set(parentId, [])
    branchesByParent.get(parentId)!.push(branch.restaurant)
  }

  return restaurants.map((restaurant) => ({
    ...restaurant,
    branches: branchesByParent.get(restaurant.id as number) ?? [],
  }))
}

async function mergeBranchesForOne(restaurant: Record<string, unknown>) {
  const restaurantId = restaurant.id as number
  if (!restaurantId) return { ...restaurant, branches: [], parent_restaurant: null }

  const [branchesData, parentsData] = await Promise.all([
    hasuraAdmin<{ restaurant_branches: Array<{ restaurant: Record<string, unknown> }> }>(
      GET_RESTAURANT_BRANCHES,
      { parent_restaurant_id: restaurantId },
    ),
    hasuraAdmin<{
      restaurant_branches: Array<{ restaurantByParentRestaurantId: Record<string, unknown> | null }>
    }>(GET_RESTAURANT_PARENTS_BULK, { restaurant_ids: [restaurantId] }),
  ])

  const branches = (branchesData.restaurant_branches ?? [])
    .map((b) => b.restaurant)
    .filter(Boolean)
  const parentRestaurant =
    parentsData.restaurant_branches?.[0]?.restaurantByParentRestaurantId ?? null

  return { ...restaurant, branches, parent_restaurant: parentRestaurant }
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function slugExists(slug: string, excludeId?: number): Promise<boolean> {
  const where: Record<string, unknown> = { slug: { _eq: slug } }
  if (excludeId) where.id = { _neq: excludeId }
  const data = await hasuraAdmin<{ restaurants: Array<{ id: number }> }>(
    `query CheckSlug($where: restaurants_bool_exp!) { restaurants(where: $where, limit: 1) { id } }`,
    { where },
  )
  return (data.restaurants?.length ?? 0) > 0
}

async function generateUniqueSlug(baseSlug: string, excludeId?: number): Promise<string> {
  let candidate = baseSlug
  let counter = 1
  while (await slugExists(candidate, excludeId)) {
    counter += 1
    candidate = `${baseSlug}-${counter}`
  }
  return candidate
}

async function fetchCuisinesAsJSONB(cuisineIds: number[]) {
  if (!cuisineIds.length) return []
  const data = await hasuraAdmin<{
    restaurant_cuisines: Array<{ id: number; name: string; slug: string }>
  }>(
    `query GetCuisinesByIds($ids: [Int!]!) { restaurant_cuisines(where: { id: { _in: $ids } }) { id name slug } }`,
    { ids: cuisineIds },
  )
  return data.restaurant_cuisines ?? []
}

async function fetchCategoriesAsJSONB(categoryIds: number[]) {
  if (!categoryIds.length) return []
  const data = await hasuraAdmin<{
    restaurant_categories: Array<{ id: number; name: string; slug: string }>
  }>(
    `query GetCategoriesByIds($ids: [Int!]!) { restaurant_categories(where: { id: { _in: $ids } }) { id name slug } }`,
    { ids: categoryIds },
  )
  return data.restaurant_categories ?? []
}

export async function listRestaurants(params: URLSearchParams) {
  const limit = Math.max(1, Math.min(parseInt(params.get('limit') ?? '100', 10) || 100, 100))
  const offset = Math.max(0, parseInt(params.get('offset') ?? '0', 10) || 0)
  const status = params.get('status')
  const search = params.get('search')
  const qualityFilter = normalizeQualityFilter(params.get('qualityFilter'))
  const usesQualityFilter = qualityFilter !== 'all'

  const baseWhere: Record<string, unknown> = {}
  if (search) {
    baseWhere._or = [
      { title: { _ilike: `%${search}%` } },
      { slug: { _ilike: `%${search}%` } },
      { listing_street: { _ilike: `%${search}%` } },
    ]
  }

  const mergeWhere = (extra?: Record<string, unknown>) => {
    const merged = { ...baseWhere, ...(extra ?? {}) }
    return Object.keys(merged).length > 0 ? merged : undefined
  }

  const where = mergeWhere(status ? { status: { _eq: status } } : undefined)
  const where_publish = mergeWhere({ status: { _eq: 'publish' } })
  const where_draft = mergeWhere({ status: { _eq: 'draft' } })
  const where_private = mergeWhere({ status: { _eq: 'private' } })

  const data = await hasuraAdmin<{
    restaurants: Array<Record<string, unknown>>
    restaurants_aggregate: { aggregate: { count: number } | null }
    publish: { aggregate: { count: number } | null }
    draft: { aggregate: { count: number } | null }
    private: { aggregate: { count: number } | null }
  }>(GET_RESTAURANTS_LIST, {
    limit: usesQualityFilter ? 10000 : limit,
    offset: usesQualityFilter ? 0 : offset,
    where,
    order_by: { created_at: 'desc' },
    where_publish,
    where_draft,
    where_private,
  })

  let restaurants: Record<string, unknown>[] = (data.restaurants ?? []).map(transformRestaurant)
  let total = data.restaurants_aggregate?.aggregate?.count ?? restaurants.length

  if (usesQualityFilter) {
    restaurants = restaurants.filter((r) =>
      matchesQualityFilter(r as RestaurantQualityFields, qualityFilter),
    )
    total = restaurants.length
    restaurants = restaurants.slice(offset, offset + limit)
  }

  restaurants = await mergeBranchesForList(restaurants)

  return {
    data: restaurants,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      statusCounts: {
        publish: data.publish?.aggregate?.count ?? 0,
        draft: data.draft?.aggregate?.count ?? 0,
        private: data.private?.aggregate?.count ?? 0,
      },
      qualityFilter,
      fetchedAt: new Date().toISOString(),
    },
  }
}

export async function getRestaurantByUuid(uuid: string) {
  const data = await hasuraAdmin<{ restaurants: Array<Record<string, unknown>> }>(
    GET_RESTAURANT_BY_UUID,
    { uuid },
  )
  const restaurant = data.restaurants?.[0]
  if (!restaurant) return null
  const transformed = transformRestaurant(restaurant)
  const withBranches = await mergeBranchesForOne(transformed)
  return {
    data: withBranches,
    meta: { fetchedAt: new Date().toISOString() },
  }
}

export async function createRestaurant(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) throw new Error('Title is required')

  const baseSlug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : generateSlug(title)
  const restaurantSlug = await generateUniqueSlug(baseSlug)

  const cuisineIds = Array.isArray(body.cuisine_ids) ? body.cuisine_ids.map(Number).filter(Boolean) : []
  const categoryIds = Array.isArray(body.category_ids) ? body.category_ids.map(Number).filter(Boolean) : []

  const cuisinesJSONB = await fetchCuisinesAsJSONB(cuisineIds)
  const categoriesJSONB = await fetchCategoriesAsJSONB(categoryIds)
  const resolvedGooglePlaceId = resolveGooglePlaceId(body.google_place_id, body.address)

  const restaurantObject: Record<string, unknown> = {
    title,
    slug: restaurantSlug,
    status: typeof body.status === 'string' ? body.status : 'draft',
    ...(typeof body.content === 'string' && body.content && { content: body.content }),
    ...(typeof body.listing_street === 'string' && body.listing_street && { listing_street: body.listing_street }),
    ...(typeof body.phone === 'string' && body.phone && { phone: body.phone }),
    ...(body.opening_hours !== undefined && body.opening_hours !== null && { opening_hours: body.opening_hours }),
    ...(typeof body.menu_url === 'string' && body.menu_url && { menu_url: body.menu_url }),
    ...(body.longitude !== undefined && body.longitude !== null && { longitude: body.longitude }),
    ...(body.latitude !== undefined && body.latitude !== null && { latitude: body.latitude }),
    ...(typeof body.featured_image_url === 'string' && body.featured_image_url && { featured_image_url: body.featured_image_url }),
    ...(body.address && typeof body.address === 'object' && !Array.isArray(body.address)
      ? { address: body.address as Record<string, unknown> }
      : {}),
    ...(Array.isArray(body.uploaded_images) && { uploaded_images: body.uploaded_images }),
    ...(cuisinesJSONB.length > 0 && { cuisines: cuisinesJSONB }),
    ...(categoriesJSONB.length > 0 && { categories: categoriesJSONB }),
    ...(resolvedGooglePlaceId && { google_place_id: resolvedGooglePlaceId }),
  }

  const data = await hasuraAdmin<{ insert_restaurants_one: Record<string, unknown> | null }>(
    CREATE_RESTAURANT,
    { object: restaurantObject },
  )
  const restaurant = data.insert_restaurants_one
  if (!restaurant) throw new Error('Failed to create restaurant')
  return { success: true, data: restaurant }
}

export async function updateRestaurant(body: Record<string, unknown>) {
  const id = typeof body.id === 'number' ? body.id : parseInt(String(body.id ?? ''), 10)
  if (!id || Number.isNaN(id)) throw new Error('Restaurant id is required')

  const changes: Record<string, unknown> = {}
  for (const key of [
    'title', 'slug', 'status', 'content', 'listing_street', 'phone', 'menu_url',
    'longitude', 'latitude', 'featured_image_url', 'address', 'uploaded_images',
    'opening_hours', 'google_place_id', 'is_main_location', 'branch_group_id',
  ] as const) {
    if (body[key] !== undefined) changes[key] = body[key]
  }

  if (typeof body.title === 'string' && body.title.trim() && !body.slug) {
    changes.slug = await generateUniqueSlug(generateSlug(body.title), id)
  } else if (typeof body.slug === 'string' && body.slug.trim()) {
    changes.slug = await generateUniqueSlug(body.slug.trim(), id)
  }

  if (Array.isArray(body.cuisine_ids)) {
    changes.cuisines = await fetchCuisinesAsJSONB(body.cuisine_ids.map(Number).filter(Boolean))
  }
  if (Array.isArray(body.category_ids)) {
    changes.categories = await fetchCategoriesAsJSONB(body.category_ids.map(Number).filter(Boolean))
  }

  const resolvedGooglePlaceId = resolveGooglePlaceId(body.google_place_id, body.address)
  if (resolvedGooglePlaceId) changes.google_place_id = resolvedGooglePlaceId

  const data = await hasuraAdmin<{ update_restaurants_by_pk: Record<string, unknown> | null }>(
    UPDATE_RESTAURANT,
    { id, changes },
  )
  if (!data.update_restaurants_by_pk) throw new Error('Restaurant not found or update failed')
  return { success: true, data: data.update_restaurants_by_pk }
}

export async function createRestaurantFromPlace(body: Record<string, unknown>) {
  const placeId = typeof body.place_id === 'string' ? body.place_id.trim() : ''
  if (!placeId) throw new Error('place_id is required')

  const details = await fetchPlaceDetails(placeId)
  if (!details) throw new Error('Place not found')

  const importFeatured = body.import_featured_image !== false
  const featuredImageUrl =
    importFeatured && details.photo_urls[0] ? details.photo_urls[0] : undefined

  return createRestaurant({
    title: details.name,
    status: body.status ?? 'draft',
    content: details.description || undefined,
    phone: details.phone || undefined,
    listing_street: details.formatted_address || undefined,
    latitude: details.latitude ?? undefined,
    longitude: details.longitude ?? undefined,
    google_place_id: details.place_id,
    address: details.address,
    opening_hours: details.business_hours?.length ? details.business_hours : details.opening_hours_text,
    featured_image_url: featuredImageUrl,
    cuisine_ids: body.cuisine_ids,
    category_ids: body.category_ids,
  })
}

export async function placesSearch(params: URLSearchParams) {
  const query = params.get('query')?.trim() ?? ''
  const location = params.get('location')?.trim()
  if (!query) throw new Error('query is required')
  const results = await searchPlaces(query, location)
  return { success: true, data: results }
}

export async function placesDetails(params: URLSearchParams) {
  const placeId = params.get('place_id')?.trim() ?? ''
  if (!placeId) throw new Error('place_id is required')
  const details = await fetchPlaceDetails(placeId)
  if (!details) throw new Error('Place not found')
  return { success: true, data: details }
}

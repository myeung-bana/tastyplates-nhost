import { hasuraQuery } from './hasura'

export type GroupScore = {
  group_slug: string
  group_name: string
  avg: number | null
  weighted: number | null
  review_count: number
  reviewer_count: number
}

export type GroupScoreMap = Record<string, GroupScore>

type CuisineRecord = {
  id: number
  slug: string
  name: string
  parent_id: number | null
}

type CombinedRow = {
  restaurant_id: number
  cuisine_id: number
  review_count: number
  rating_avg: number | null
  rating_weighted: number | null
  reviewer_count: number
}

const GET_CUISINES = `
  query GetCuisinesForGroupScores {
    restaurant_cuisines(order_by: { id: asc }) {
      id slug name parent_id
    }
  }
`

const GET_COMBINED_ROWS = `
  query GetCombinedRowsForGroupScores(
    $cuisineIds: [Int!]!
    $restaurantIds: [bigint!]
  ) {
    restaurant_palate_rating_summary_combined(
      where: {
        cuisine_id: { _in: $cuisineIds }
        restaurant_id: { _in: $restaurantIds }
      }
    ) {
      restaurant_id cuisine_id review_count rating_avg rating_weighted reviewer_count
    }
  }
`

const GET_COMBINED_ROWS_ALL = `
  query GetCombinedRowsForGroupScoresAll($cuisineIds: [Int!]!) {
    restaurant_palate_rating_summary_combined(
      where: { cuisine_id: { _in: $cuisineIds } }
    ) {
      restaurant_id cuisine_id review_count rating_avg rating_weighted reviewer_count
    }
  }
`

const RESOLVE_RESTAURANTS = `
  query ResolveRestaurantsForGroupScores($uuids: [uuid!]!) {
    restaurants(where: { uuid: { _in: $uuids } }) {
      id uuid
    }
  }
`

const RESOLVE_RESTAURANT_IDS = `
  query ResolveRestaurantIdsForGroupScores($ids: [bigint!]!) {
    restaurants(where: { id: { _in: $ids } }) {
      id uuid
    }
  }
`

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
}

function buildCuisineMaps(cuisines: CuisineRecord[]) {
  const leafBySlug = new Map<string, CuisineRecord>()
  const parentById = new Map<number, CuisineRecord>()

  for (const row of cuisines) {
    const normalized = { ...row, slug: normalizeSlug(row.slug) }
    if (normalized.parent_id == null) {
      parentById.set(normalized.id, normalized)
    } else {
      leafBySlug.set(normalized.slug, normalized)
    }
  }

  return { leafBySlug, parentById }
}

function pickWinningRow(
  rows: CombinedRow[],
  parentById: Map<number, CuisineRecord>,
): CombinedRow | null {
  if (rows.length === 0) return null

  return [...rows].sort((a, b) => {
    if (b.review_count !== a.review_count) return b.review_count - a.review_count
    if (b.reviewer_count !== a.reviewer_count) return b.reviewer_count - a.reviewer_count
    const slugA = normalizeSlug(parentById.get(a.cuisine_id)?.slug ?? '')
    const slugB = normalizeSlug(parentById.get(b.cuisine_id)?.slug ?? '')
    return slugA.localeCompare(slugB)
  })[0]
}

/**
 * Resolve group scores for restaurants based on the user's leaf palate slugs.
 * Picks the parent cuisine group with the most reviews at each restaurant.
 */
export async function getGroupScoresForPalates(
  palateSlugs: string[],
  restaurantUuids?: string[],
): Promise<GroupScoreMap> {
  const slugs = [...new Set(palateSlugs.map(normalizeSlug).filter(Boolean))]
  if (slugs.length === 0) return {}

  const cuisinesResult = await hasuraQuery<{ restaurant_cuisines: CuisineRecord[] }>(GET_CUISINES)
  if (cuisinesResult.errors?.length) {
    throw new Error(cuisinesResult.errors.map((e) => e.message).join(', '))
  }

  const cuisines = cuisinesResult.data?.restaurant_cuisines ?? []
  const { leafBySlug, parentById } = buildCuisineMaps(cuisines)

  const parentIds = new Set<number>()
  for (const slug of slugs) {
    const leaf = leafBySlug.get(slug)
    if (leaf?.parent_id != null) parentIds.add(leaf.parent_id)
  }
  if (parentIds.size === 0) return {}

  const cuisineIds = [...parentIds]
  const idToUuid = new Map<number, string>()
  let restaurantIds: number[] | undefined

  if (restaurantUuids && restaurantUuids.length > 0) {
    const uuids = [...new Set(restaurantUuids.map((u) => u.trim()).filter(Boolean))]
    if (uuids.length === 0) return {}

    const resolved = await hasuraQuery<{ restaurants: Array<{ id: number; uuid: string }> }>(
      RESOLVE_RESTAURANTS,
      { uuids },
    )
    if (resolved.errors?.length) {
      throw new Error(resolved.errors.map((e) => e.message).join(', '))
    }

    restaurantIds = []
    for (const row of resolved.data?.restaurants ?? []) {
      restaurantIds.push(row.id)
      idToUuid.set(row.id, row.uuid)
    }
    if (restaurantIds.length === 0) return {}
  }

  const combinedResult = restaurantIds
    ? await hasuraQuery<{ restaurant_palate_rating_summary_combined: CombinedRow[] }>(
        GET_COMBINED_ROWS,
        { cuisineIds, restaurantIds },
      )
    : await hasuraQuery<{ restaurant_palate_rating_summary_combined: CombinedRow[] }>(
        GET_COMBINED_ROWS_ALL,
        { cuisineIds },
      )

  if (combinedResult.errors?.length) {
    throw new Error(combinedResult.errors.map((e) => e.message).join(', '))
  }

  const combinedRows = combinedResult.data?.restaurant_palate_rating_summary_combined ?? []
  if (combinedRows.length === 0) return {}

  if (!restaurantIds) {
    const uniqueRestaurantIds = [...new Set(combinedRows.map((row) => row.restaurant_id))]
    const resolved = await hasuraQuery<{ restaurants: Array<{ id: number; uuid: string }> }>(
      RESOLVE_RESTAURANT_IDS,
      { ids: uniqueRestaurantIds },
    )
    if (resolved.errors?.length) {
      throw new Error(resolved.errors.map((e) => e.message).join(', '))
    }
    for (const row of resolved.data?.restaurants ?? []) {
      idToUuid.set(row.id, row.uuid)
    }
  }

  const rowsByRestaurant = new Map<number, CombinedRow[]>()
  for (const row of combinedRows) {
    const list = rowsByRestaurant.get(row.restaurant_id) ?? []
    list.push(row)
    rowsByRestaurant.set(row.restaurant_id, list)
  }

  const result: GroupScoreMap = {}
  for (const [restaurantId, rows] of rowsByRestaurant) {
    const uuid = idToUuid.get(restaurantId)
    if (!uuid) continue

    const winner = pickWinningRow(rows, parentById)
    if (!winner) continue

    const parent = parentById.get(winner.cuisine_id)
    if (!parent) continue

    result[uuid] = {
      group_slug: normalizeSlug(parent.slug),
      group_name: parent.name,
      avg: winner.rating_avg,
      weighted: winner.rating_weighted,
      review_count: winner.review_count,
      reviewer_count: winner.reviewer_count,
    }
  }

  return result
}

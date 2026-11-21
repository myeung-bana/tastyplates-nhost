import { hasuraQuery } from './hasura'
import {
  hasIdentity,
  leafIdsForSlugs,
  NATIVE_WEIGHT,
  resolveRestaurantCuisines,
  reviewerHasAnyLeaf,
  SCRAPED_WEIGHT,
  scorePool,
} from './reviewPool'
import { loadReviewPool } from './reviewPoolLoader'

import {
  PALATE_RATING_MIN_LEAF_REVIEWS,
  type PalateRatingSource,
} from './rebuildPalateRatingSummary'

export type PalateRatingRow = {
  cuisine_id: number
  cuisine_slug: string
  cuisine_name: string
  parent_id: number | null
  parent_slug: string | null
  parent_name: string | null
  is_parent: boolean
  review_source: PalateRatingSource | 'combined'
  review_count: number
  rating_sum: number | null
  rating_avg: number | null
  rating_weighted: number | null
  reviewer_count: number
  /** Σ weight × review_count (native 2, scraped 1). For combined rows this is the view's column. */
  total_weight: number
  has_data: boolean
  updated_at: string | null
}

export type PalateRatingGroup = {
  parent: PalateRatingRow
  leaves: PalateRatingRow[]
}

type CuisineRecord = {
  id: number
  slug: string
  name: string
  parent_id: number | null
}

type StoredMetrics = {
  review_count: number
  total_weight: number
  rating_sum: number | null
  rating_avg: number | null
  rating_weighted: number | null
  reviewer_count: number
  updated_at?: string | null
}

const GET_CUISINES = `
  query GetCuisinesForPalateRatingRead {
    restaurant_cuisines(order_by: [{ parent_id: asc_nulls_first }, { name: asc }]) {
      id slug name parent_id
    }
  }
`

const GET_SUMMARY_ROWS = `
  query GetPalateSummaryRows($restaurantId: Int!) {
    restaurant_palate_rating_summary(
      where: { restaurant_id: { _eq: $restaurantId } }
      order_by: [{ cuisine_id: asc }, { review_source: asc }]
    ) {
      cuisine_id review_source review_count rating_sum rating_avg rating_weighted reviewer_count updated_at
    }
  }
`

const GET_COMBINED_ROWS = `
  query GetPalateCombinedRows($restaurantId: Int!) {
    restaurant_palate_rating_summary_combined(
      where: { restaurant_id: { _eq: $restaurantId } }
      order_by: { cuisine_id: asc }
    ) {
      cuisine_id review_count rating_sum rating_avg rating_weighted reviewer_count total_weight
    }
  }
`

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
}

const EMPTY_METRICS: StoredMetrics = {
  review_count: 0,
  total_weight: 0,
  rating_sum: null,
  rating_avg: null,
  rating_weighted: null,
  reviewer_count: 0,
  updated_at: null,
}

function buildCuisineRow(
  cuisine: CuisineRecord,
  parentById: Map<number, CuisineRecord>,
  source: PalateRatingSource | 'combined',
  metrics: StoredMetrics,
): PalateRatingRow {
  const parent = cuisine.parent_id != null ? parentById.get(cuisine.parent_id) : null
  const hasData = metrics.review_count > 0

  return {
    cuisine_id: cuisine.id,
    cuisine_slug: normalizeSlug(cuisine.slug),
    cuisine_name: cuisine.name,
    parent_id: cuisine.parent_id,
    parent_slug: parent ? normalizeSlug(parent.slug) : null,
    parent_name: parent?.name ?? null,
    is_parent: cuisine.parent_id == null,
    review_source: source,
    review_count: metrics.review_count,
    rating_sum: hasData ? metrics.rating_sum : null,
    rating_avg: hasData ? metrics.rating_avg : null,
    rating_weighted: hasData ? metrics.rating_weighted : null,
    reviewer_count: metrics.reviewer_count,
    total_weight: metrics.total_weight,
    has_data: hasData,
    updated_at: metrics.updated_at ?? null,
  }
}

function buildMetricsMaps(
  summaryRows: Array<{
    cuisine_id: number
    review_source: PalateRatingSource
    review_count: number
    rating_sum: number
    rating_avg: number | null
    rating_weighted: number | null
    reviewer_count: number
    updated_at: string
  }>,
  combinedRows: Array<{
    cuisine_id: number
    review_count: number
    total_weight: number
    rating_sum: number
    rating_avg: number | null
    rating_weighted: number | null
    reviewer_count: number
  }>,
) {
  const external = new Map<number, StoredMetrics>()
  const firstParty = new Map<number, StoredMetrics>()
  const combined = new Map<number, StoredMetrics>()

  for (const row of summaryRows) {
    const weight = row.review_source === 'first_party' ? NATIVE_WEIGHT : SCRAPED_WEIGHT
    const metrics: StoredMetrics = {
      review_count: row.review_count,
      total_weight: row.review_count * weight,
      rating_sum: row.rating_sum,
      rating_avg: row.rating_avg,
      rating_weighted: row.rating_weighted,
      reviewer_count: row.reviewer_count,
      updated_at: row.updated_at,
    }
    if (row.review_source === 'external') external.set(row.cuisine_id, metrics)
    if (row.review_source === 'first_party') firstParty.set(row.cuisine_id, metrics)
  }

  for (const row of combinedRows) {
    combined.set(row.cuisine_id, {
      review_count: row.review_count,
      total_weight: Number(row.total_weight) || 0,
      rating_sum: row.rating_sum,
      rating_avg: row.rating_avg,
      rating_weighted: row.rating_weighted,
      reviewer_count: row.reviewer_count,
    })
  }

  return { external, first_party: firstParty, combined }
}

function densifySourceGrid(
  cuisines: CuisineRecord[],
  parentById: Map<number, CuisineRecord>,
  source: PalateRatingSource | 'combined',
  metricsByCuisineId: Map<number, StoredMetrics>,
): PalateRatingRow[] {
  return cuisines.map((cuisine) =>
    buildCuisineRow(
      cuisine,
      parentById,
      source,
      metricsByCuisineId.get(cuisine.id) ?? EMPTY_METRICS,
    ),
  )
}

function buildGroups(rows: PalateRatingRow[]): PalateRatingGroup[] {
  const parentRows = rows.filter((row) => row.is_parent)
  const leavesByParentId = new Map<number, PalateRatingRow[]>()

  for (const row of rows) {
    if (row.is_parent || row.parent_id == null) continue
    const list = leavesByParentId.get(row.parent_id) ?? []
    list.push(row)
    leavesByParentId.set(row.parent_id, list)
  }

  return parentRows.map((parent) => ({
    parent,
    leaves: (leavesByParentId.get(parent.cuisine_id) ?? []).sort((a, b) =>
      a.cuisine_name.localeCompare(b.cuisine_name),
    ),
  }))
}

export async function getRestaurantPalateRatings(
  restaurantUuid: string,
  sourceFilter: 'all' | PalateRatingSource | 'combined' = 'all',
) {
  const uuid = restaurantUuid.trim()
  const resolved = await hasuraQuery<{ restaurants: Array<{ id: number; cuisines: unknown }> }>(
    `query ResolveRestaurant($uuid: uuid!) {
      restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) { id cuisines }
    }`,
    { uuid },
  )
  if (resolved.errors?.length) {
    throw new Error(resolved.errors.map((e) => e.message).join(', '))
  }
  const restaurantId = resolved.data?.restaurants?.[0]?.id
  if (!restaurantId) throw new Error('Restaurant not found')

  const [cuisinesResult, summaryResult, combinedResult] = await Promise.all([
    hasuraQuery<{ restaurant_cuisines: CuisineRecord[] }>(GET_CUISINES),
    hasuraQuery<{
      restaurant_palate_rating_summary: Array<{
        cuisine_id: number
        review_source: PalateRatingSource
        review_count: number
        rating_sum: number
        rating_avg: number | null
        rating_weighted: number | null
        reviewer_count: number
        updated_at: string
      }>
    }>(GET_SUMMARY_ROWS, { restaurantId }),
    hasuraQuery<{
      restaurant_palate_rating_summary_combined: Array<{
        cuisine_id: number
        review_count: number
        rating_sum: number
        rating_avg: number | null
        rating_weighted: number | null
        reviewer_count: number
        total_weight: number
      }>
    }>(GET_COMBINED_ROWS, { restaurantId }),
  ])

  // Coverage and score links come from the same review pool the scores use.
  const pool = await loadReviewPool({ restaurantUuids: [uuid] })
  const withPalate = pool.entries.filter((entry) => hasIdentity(entry.identity)).length
  const restaurantCuisines = resolveRestaurantCuisines(
    resolved.data?.restaurants?.[0]?.cuisines,
    pool.taxonomy,
  )

  if (cuisinesResult.errors?.length) {
    throw new Error(cuisinesResult.errors.map((e) => e.message).join(', '))
  }
  if (summaryResult.errors?.length) {
    throw new Error(summaryResult.errors.map((e) => e.message).join(', '))
  }
  if (combinedResult.errors?.length) {
    throw new Error(combinedResult.errors.map((e) => e.message).join(', '))
  }

  const cuisines = cuisinesResult.data?.restaurant_cuisines ?? []
  const parentById = new Map(
    cuisines.filter((cuisine) => cuisine.parent_id == null).map((cuisine) => [cuisine.id, cuisine]),
  )
  const metricsMaps = buildMetricsMaps(
    summaryResult.data?.restaurant_palate_rating_summary ?? [],
    combinedResult.data?.restaurant_palate_rating_summary_combined ?? [],
  )

  const sources = {
    external: densifySourceGrid(cuisines, parentById, 'external', metricsMaps.external),
    first_party: densifySourceGrid(cuisines, parentById, 'first_party', metricsMaps.first_party),
    combined: densifySourceGrid(cuisines, parentById, 'combined', metricsMaps.combined),
  }

  const groups = {
    external: buildGroups(sources.external),
    first_party: buildGroups(sources.first_party),
    combined: buildGroups(sources.combined),
  }

  const filterSource = <T,>(key: keyof typeof sources, value: T): T | [] => {
    if (sourceFilter === 'all' || sourceFilter === key) return value
    return []
  }

  return {
    restaurant_uuid: uuid,
    restaurant_id: restaurantId,
    sources: {
      external: filterSource('external', sources.external),
      first_party: filterSource('first_party', sources.first_party),
      combined: filterSource('combined', sources.combined),
    },
    groups: {
      external: filterSource('external', groups.external),
      first_party: filterSource('first_party', groups.first_party),
      combined: filterSource('combined', groups.combined),
    },
    meta: {
      min_leaf_review_count: PALATE_RATING_MIN_LEAF_REVIEWS,
      /** Review pool for this restaurant (v3). Reviews without a palate only reach Overall. */
      coverage: {
        pool_reviews: pool.entries.length,
        native_reviews: pool.entries.filter((entry) => entry.source === 'first_party').length,
        scraped_reviews: pool.entries.filter((entry) => entry.source === 'external').length,
        with_palate: withPalate,
        overall_only: pool.entries.length - withPalate,
      },
      /** Cuisine/region ids whose rows feed Authentic (the restaurant's own cuisines). Region rows feed Group. */
      authentic_cuisine_ids: [...restaurantCuisines.leafIds, ...restaurantCuisines.regionIds],
      total_cuisines: cuisines.length,
      populated_counts: {
        external: sources.external.filter((row) => row.has_data).length,
        first_party: sources.first_party.filter((row) => row.has_data).length,
        combined: sources.combined.filter((row) => row.has_data).length,
      },
    },
  }
}

export async function getPalateRatingSummary(restaurantUuid: string, palateSlug: string) {
  const slug = normalizeSlug(palateSlug)
  const data = await getRestaurantPalateRatings(restaurantUuid, 'combined')
  const cuisinesResult = await hasuraQuery<{ restaurant_cuisines: CuisineRecord[] }>(GET_CUISINES)
  if (cuisinesResult.errors?.length) {
    throw new Error(cuisinesResult.errors.map((e) => e.message).join(', '))
  }
  const cuisines = cuisinesResult.data?.restaurant_cuisines ?? []
  const leaf = cuisines.find(
    (cuisine) => normalizeSlug(cuisine.slug) === slug && cuisine.parent_id != null,
  )
  if (!leaf) throw new Error(`Unknown reviewer cuisine slug: ${palateSlug}`)

  const parent = cuisines.find((cuisine) => cuisine.id === leaf.parent_id)
  const combinedRows = data.sources.combined
  const leafRow = combinedRows.find((row) => row.cuisine_id === leaf.id)
  const parentRow = parent
    ? combinedRows.find((row) => row.cuisine_id === parent.id)
    : undefined

  const useLeaf = (leafRow?.review_count ?? 0) >= PALATE_RATING_MIN_LEAF_REVIEWS && leafRow?.has_data
  const resolved = useLeaf ? leafRow : parentRow?.has_data ? parentRow : undefined

  return {
    restaurant_uuid: data.restaurant_uuid,
    requested_palate_slug: slug,
    rating_avg: resolved?.rating_avg ?? null,
    rating_weighted: resolved?.rating_weighted ?? null,
    review_count: resolved?.review_count ?? 0,
    reviewer_count: resolved?.reviewer_count ?? 0,
    resolved_palate_slug: useLeaf
      ? normalizeSlug(leaf.slug)
      : parent
        ? normalizeSlug(parent.slug)
        : slug,
    is_fallback: !useLeaf,
    review_source: 'combined' as const,
  }
}

export async function getPreferenceStatsForRestaurant(
  restaurantUuid: string,
  palateSlugs: string[],
) {
  const uuid = restaurantUuid.trim()
  const slugs = [...new Set(palateSlugs.map(normalizeSlug).filter(Boolean))]

  // One pool load for this restaurant; each palate and the union are scored from it.
  const { entries, taxonomy } = await loadReviewPool({ restaurantUuids: [uuid] })

  const statsByPalate: Record<
    string,
    { avg: number | null; count: number; shared_unlocked: boolean }
  > = {}

  for (const slug of slugs) {
    const score = scorePool(
      entries,
      reviewerHasAnyLeaf(leafIdsForSlugs([slug], taxonomy, { expandRegions: true })),
    )
    statsByPalate[slug] = {
      avg: score.display_avg,
      count: score.review_count,
      shared_unlocked: score.review_count >= PALATE_RATING_MIN_LEAF_REVIEWS,
    }
  }

  // Union of the requested palates: a reviewer with two of them counts once.
  const combined = scorePool(
    entries,
    reviewerHasAnyLeaf(leafIdsForSlugs(slugs, taxonomy, { expandRegions: true })),
  )

  return {
    restaurant_uuid: uuid,
    palates_requested: slugs,
    stats_by_palate: statsByPalate,
    combined: {
      avg: combined.display_avg != null ? Number(combined.display_avg.toFixed(2)) : null,
      count: combined.review_count,
    },
  }
}

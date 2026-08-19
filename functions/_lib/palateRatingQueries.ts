import { hasuraQuery } from './hasura'
import { aggregatePreferenceStatsByPalates } from './preference-stats-aggregate'
import {
  PALATE_RATING_MIN_LEAF_REVIEWS,
  type PalateRatingSource,
} from './rebuildPalateRatingSummary'

export type PalateRatingRow = {
  palate_id: number
  palate_slug: string
  palate_name: string
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
  updated_at: string | null
}

const GET_PALATES = `
  query GetPalatesForRatingRead {
    restaurant_palates(order_by: [{ parent_id: asc_nulls_first }, { name: asc }]) {
      id slug name parent_id
    }
  }
`

const GET_SUMMARY_ROWS = `
  query GetPalateSummaryRows($restaurantId: Int!) {
    restaurant_palate_rating_summary(
      where: { restaurant_id: { _eq: $restaurantId } }
      order_by: [{ palate_id: asc }, { review_source: asc }]
    ) {
      palate_id review_source review_count rating_sum rating_avg rating_weighted reviewer_count updated_at
    }
  }
`

const GET_COMBINED_ROWS = `
  query GetPalateCombinedRows($restaurantId: Int!) {
    restaurant_palate_rating_summary_combined(
      where: { restaurant_id: { _eq: $restaurantId } }
      order_by: { palate_id: asc }
    ) {
      palate_id review_count rating_sum rating_avg rating_weighted reviewer_count
    }
  }
`

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
}

export async function getRestaurantPalateRatings(
  restaurantUuid: string,
  sourceFilter: 'all' | PalateRatingSource | 'combined' = 'all',
) {
  const uuid = restaurantUuid.trim()
  const resolved = await hasuraQuery<{ restaurants: Array<{ id: number }> }>(
    `query ResolveRestaurant($uuid: uuid!) {
      restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) { id }
    }`,
    { uuid },
  )
  if (resolved.errors?.length) {
    throw new Error(resolved.errors.map((e) => e.message).join(', '))
  }
  const restaurantId = resolved.data?.restaurants?.[0]?.id
  if (!restaurantId) throw new Error('Restaurant not found')

  const [palatesResult, summaryResult, combinedResult] = await Promise.all([
    hasuraQuery<{
      restaurant_palates: Array<{
        id: number
        slug: string
        name: string
        parent_id: number | null
      }>
    }>(GET_PALATES),
    hasuraQuery<{
      restaurant_palate_rating_summary: Array<{
        palate_id: number
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
        palate_id: number
        review_count: number
        rating_sum: number
        rating_avg: number | null
        rating_weighted: number | null
        reviewer_count: number
      }>
    }>(GET_COMBINED_ROWS, { restaurantId }),
  ])

  if (palatesResult.errors?.length) {
    throw new Error(palatesResult.errors.map((e) => e.message).join(', '))
  }
  if (summaryResult.errors?.length) {
    throw new Error(summaryResult.errors.map((e) => e.message).join(', '))
  }
  if (combinedResult.errors?.length) {
    throw new Error(combinedResult.errors.map((e) => e.message).join(', '))
  }

  const palates = palatesResult.data?.restaurant_palates ?? []
  const palateById = new Map(palates.map((p) => [p.id, p]))
  const parentById = new Map(
    palates.filter((p) => p.parent_id == null).map((p) => [p.id, p]),
  )
  const combinedMap = new Map(
    (combinedResult.data?.restaurant_palate_rating_summary_combined ?? []).map((row) => [
      row.palate_id,
      row,
    ]),
  )

  const toRow = (
    palate: (typeof palates)[number],
    source: PalateRatingSource | 'combined',
    metrics: {
      review_count: number
      rating_sum?: number | null
      rating_avg: number | null
      rating_weighted: number | null
      reviewer_count: number
      updated_at?: string | null
    },
  ): PalateRatingRow => {
    const parent = palate.parent_id != null ? parentById.get(palate.parent_id) : null
    return {
      palate_id: palate.id,
      palate_slug: normalizeSlug(palate.slug),
      palate_name: palate.name,
      parent_id: palate.parent_id,
      parent_slug: parent ? normalizeSlug(parent.slug) : null,
      parent_name: parent?.name ?? null,
      is_parent: palate.parent_id == null,
      review_source: source,
      review_count: metrics.review_count,
      rating_sum: metrics.rating_sum ?? null,
      rating_avg: metrics.rating_avg,
      rating_weighted: metrics.rating_weighted,
      reviewer_count: metrics.reviewer_count,
      updated_at: metrics.updated_at ?? null,
    }
  }

  const grouped: Record<string, PalateRatingRow[]> = {
    external: [],
    first_party: [],
    combined: [],
  }

  for (const summary of summaryResult.data?.restaurant_palate_rating_summary ?? []) {
    const palate = palateById.get(summary.palate_id)
    if (!palate) continue
    grouped[summary.review_source].push(
      toRow(palate, summary.review_source, {
        review_count: summary.review_count,
        rating_sum: summary.rating_sum,
        rating_avg: summary.rating_avg,
        rating_weighted: summary.rating_weighted,
        reviewer_count: summary.reviewer_count,
        updated_at: summary.updated_at,
      }),
    )
  }

  for (const [palateId, combined] of combinedMap.entries()) {
    const palate = palateById.get(palateId)
    if (!palate || combined.review_count <= 0) continue
    grouped.combined.push(
      toRow(palate, 'combined', {
        review_count: combined.review_count,
        rating_sum: combined.rating_sum,
        rating_avg: combined.rating_avg,
        rating_weighted: combined.rating_weighted,
        reviewer_count: combined.reviewer_count,
      }),
    )
  }

  const sortRows = (rows: PalateRatingRow[]) =>
    rows.sort((a, b) => {
      if (a.is_parent !== b.is_parent) return a.is_parent ? -1 : 1
      return a.palate_name.localeCompare(b.palate_name)
    })

  const parents = palates
    .filter((p) => p.parent_id == null)
    .map((p) => ({
      palate_id: p.id,
      palate_slug: normalizeSlug(p.slug),
      palate_name: p.name,
    }))

  const filterRows = (key: keyof typeof grouped) => {
    if (sourceFilter === 'all' || sourceFilter === key) return sortRows(grouped[key])
    return []
  }

  return {
    restaurant_uuid: uuid,
    restaurant_id: restaurantId,
    sources: {
      external: filterRows('external'),
      first_party: filterRows('first_party'),
      combined: filterRows('combined'),
    },
    parents,
    meta: {
      min_leaf_review_count: PALATE_RATING_MIN_LEAF_REVIEWS,
    },
  }
}

export async function getPalateRatingSummary(restaurantUuid: string, palateSlug: string) {
  const slug = normalizeSlug(palateSlug)
  const data = await getRestaurantPalateRatings(restaurantUuid, 'combined')
  const palatesResult = await hasuraQuery<{
    restaurant_palates: Array<{
      id: number
      slug: string
      name: string
      parent_id: number | null
    }>
  }>(GET_PALATES)

  const palates = palatesResult.data?.restaurant_palates ?? []
  const leaf = palates.find((p) => normalizeSlug(p.slug) === slug && p.parent_id != null)
  if (!leaf) throw new Error(`Unknown leaf palate slug: ${palateSlug}`)

  const parent = palates.find((p) => p.id === leaf.parent_id)
  const combinedRows = data.sources.combined
  const leafRow = combinedRows.find((row) => row.palate_id === leaf.id)
  const parentRow = parent
    ? combinedRows.find((row) => row.palate_id === parent.id)
    : undefined

  const useLeaf = (leafRow?.review_count ?? 0) >= PALATE_RATING_MIN_LEAF_REVIEWS
  const resolved = useLeaf ? leafRow : parentRow

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

  const statsByPalate: Record<
    string,
    { avg: number | null; count: number; shared_unlocked: boolean }
  > = {}

  let combinedSum = 0
  let combinedCount = 0

  for (const slug of slugs) {
    const stats = await aggregatePreferenceStatsByPalates([slug])
    const row = stats[uuid]
    const count = row?.count ?? 0
    statsByPalate[slug] = {
      avg: row?.avg ?? null,
      count,
      shared_unlocked: count >= PALATE_RATING_MIN_LEAF_REVIEWS,
    }
    if (row) {
      combinedSum += row.avg * row.count
      combinedCount += row.count
    }
  }

  return {
    restaurant_uuid: uuid,
    palates_requested: slugs,
    stats_by_palate: statsByPalate,
    combined: {
      avg: combinedCount > 0 ? Number((combinedSum / combinedCount).toFixed(2)) : null,
      count: combinedCount,
    },
  }
}

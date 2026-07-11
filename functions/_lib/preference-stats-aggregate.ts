import { hasuraQuery } from './hasura'
import {
  fetchGoogleRatingAggregateMap,
  mergeGoogleRatingAggregatesIntoAccumulator,
} from './googleRatingPrior'
import { REVIEW_AUTHOR_GRAPHQL_NESTED } from './review-enrichment'

const GET_REVIEWS_FOR_PREFERENCE = `
  query GetReviewsForPreference($where: restaurant_reviews_bool_exp, $limit: Int) {
    restaurant_reviews(where: $where, limit: $limit) {
      restaurant_uuid
      rating
      palates
      ${REVIEW_AUTHOR_GRAPHQL_NESTED}
    }
  }
`

export type PreferenceStatsMap = Record<string, { avg: number; count: number }>

function normalizePalateList(raw: string[]): string[] {
  return [...new Set(raw.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort()
}

function extractReviewPalates(palates: unknown): string[] {
  if (!palates) return []
  if (Array.isArray(palates)) {
    if (palates.every((p) => typeof p === 'string')) {
      return palates.map((p) => p.toLowerCase())
    }
    return palates
      .map((p: unknown) =>
        typeof p === 'string' ? p : String((p as { slug?: string; name?: string })?.slug ?? (p as { name?: string })?.name ?? ''),
      )
      .filter(Boolean)
      .map((p) => p.toLowerCase())
  }
  if (typeof palates === 'string') {
    try {
      return extractReviewPalates(JSON.parse(palates) as unknown)
    } catch {
      return palates
        .split('|')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    }
  }
  return []
}

/**
 * Live aggregation from reviews + reviewer profile palates (web `get-preference-stats` parity).
 */
export async function aggregatePreferenceStatsByPalates(
  palateSlugs: string[],
): Promise<PreferenceStatsMap> {
  const palates = normalizePalateList(palateSlugs)
  if (palates.length === 0) return {}

  const where = {
    _and: [
      { deleted_at: { _is_null: true } },
      { parent_review_id: { _is_null: true } },
    ],
  }

  type ReviewRow = {
    restaurant_uuid: string | null
    rating: number | null
    palates: unknown
    AuthorProfile?: { palates?: unknown } | null
  }

  const result = await hasuraQuery<{ restaurant_reviews: ReviewRow[] }>(
    GET_REVIEWS_FOR_PREFERENCE,
    { where, limit: 5000 },
  )

  if (result.errors?.length) {
    throw new Error(result.errors[0]?.message ?? 'Failed to fetch reviews for preference stats')
  }

  const rows = result.data?.restaurant_reviews ?? []
  const palateSet = new Set(palates)
  const acc = new Map<string, { sum: number; count: number }>()

  for (const row of rows) {
    const restaurantUuid = row.restaurant_uuid?.trim()
    if (!restaurantUuid) continue

    const rating = Number(row.rating) || 0
    if (rating <= 0) continue

    const authorPalates = extractReviewPalates(row.AuthorProfile?.palates)
    const reviewerPalates =
      authorPalates.length > 0 ? authorPalates : extractReviewPalates(row.palates)
    const matches = reviewerPalates.some((p) => palateSet.has(p))
    if (!matches) continue

    const cur = acc.get(restaurantUuid) ?? { sum: 0, count: 0 }
    cur.sum += rating
    cur.count += 1
    acc.set(restaurantUuid, cur)
  }

  const googleAggregateMap = await fetchGoogleRatingAggregateMap()
  mergeGoogleRatingAggregatesIntoAccumulator(acc, googleAggregateMap)

  const out: PreferenceStatsMap = {}
  for (const [uuid, { sum, count }] of acc.entries()) {
    out[uuid] = { avg: sum / count, count }
  }
  return out
}

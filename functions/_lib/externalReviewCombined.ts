import { hasuraQuery } from './hasura'
import { getExternalReviewSummary } from './externalReviewQueries'
import type { ExternalReviewSummaryRow } from './externalReviewTypes'

const GET_FIRST_PARTY_SUMMARY = `
  query GetFirstPartySummary($restaurantId: bigint!) {
    restaurant_rating_summary(where: { restaurant_id: { _eq: $restaurantId } }, limit: 1) {
      overall_review_count
      overall_rating_avg
    }
  }
`

const RESOLVE_RESTAURANT_ID = `
  query ResolveRestaurantId($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      id
    }
  }
`

const GET_FIRST_PARTY_PALATES = `
  query GetFirstPartyPalates($restaurantUuid: uuid!) {
    restaurant_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
    ) {
      palates
    }
  }
`

const GET_EXTERNAL_AUTHOR_PALATES = `
  query GetExternalAuthorPalates($restaurantUuid: uuid!) {
    restaurant_external_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        is_flagged: { _eq: false }
      }
    ) {
      rating
      author_palates
    }
  }
`

function mergeCountMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = { ...a }
  for (const [key, count] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + count
  }
  return merged
}

function extractReviewPalates(palates: unknown): string[] {
  if (!palates) return []
  if (Array.isArray(palates)) {
    return palates
      .map((p) => {
        if (typeof p === 'string') return p.trim().toLowerCase()
        if (typeof p === 'object' && p !== null) {
          const val =
            (p as { slug?: string; name?: string }).slug ??
            (p as { name?: string }).name ??
            ''
          return String(val).trim().toLowerCase()
        }
        return String(p).trim().toLowerCase()
      })
      .filter(Boolean)
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

function buildPalateBreakdown(reviews: Array<{ palates: unknown }>): Record<string, number> {
  const breakdown: Record<string, number> = {}
  for (const review of reviews) {
    for (const slug of extractReviewPalates(review.palates)) {
      breakdown[slug] = (breakdown[slug] ?? 0) + 1
    }
  }
  return breakdown
}

function dominantLanguage(breakdown: Record<string, number>): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [lang, count] of Object.entries(breakdown)) {
    if (count > bestCount) {
      bestCount = count
      best = lang
    }
  }
  return best
}

function buildAuthorPalateBreakdown(
  reviews: Array<{ rating: number; author_palates: string[] | null }>,
): Record<string, { count: number; avg: number }> {
  const stats: Record<string, { sum: number; count: number }> = {}
  for (const review of reviews) {
    const rating = Number(review.rating)
    if (!Number.isFinite(rating) || rating <= 0) continue
    for (const slug of review.author_palates ?? []) {
      const key = slug.trim().toLowerCase()
      if (!key) continue
      if (!stats[key]) stats[key] = { sum: 0, count: 0 }
      stats[key].sum += rating
      stats[key].count += 1
    }
  }
  const out: Record<string, { count: number; avg: number }> = {}
  for (const [key, value] of Object.entries(stats)) {
    out[key] = { count: value.count, avg: Number((value.sum / value.count).toFixed(2)) }
  }
  return out
}

export interface CombinedSummaryResult {
  restaurant_id: string
  first_party: {
    total_count: number
    average_rating: number | null
    palate_breakdown: Record<string, number>
  }
  external: {
    total_count: number
    average_rating: number | null
    platform_breakdown: Record<string, { count: number; avg: number }>
    language_breakdown: Record<string, number>
    palate_breakdown: Record<string, number>
    author_palate_breakdown: Record<string, { count: number; avg: number }>
    sentiment_breakdown: Record<string, number>
  }
  combined: {
    weighted_rating: number | null
    confidence_score: number
    palate_signals: Record<string, number>
    dominant_language: string | null
  }
}

function emptyExternalSummary(): ExternalReviewSummaryRow {
  return {
    restaurant_uuid: '',
    total_count: 0,
    average_rating: null,
    platform_breakdown: {},
    language_breakdown: {},
    palate_breakdown: {},
    sentiment_breakdown: {},
    last_updated_at: new Date().toISOString(),
  }
}

export async function getCombinedSummary(restaurantUuid: string): Promise<CombinedSummaryResult> {
  const uuid = restaurantUuid.trim()

  const resolved = await hasuraQuery<{ restaurants: Array<{ id: number }> }>(RESOLVE_RESTAURANT_ID, {
    uuid,
  })
  if (resolved.errors?.length) {
    throw new Error(resolved.errors.map((e) => e.message).join(', '))
  }
  const restaurantId = resolved.data?.restaurants?.[0]?.id
  if (!restaurantId) throw new Error('Restaurant not found')

  const [fpSummaryResult, fpPalatesResult, externalSummary, externalAuthorPalates] = await Promise.all([
    hasuraQuery<{
      restaurant_rating_summary: Array<{
        overall_review_count: number
        overall_rating_avg: number | null
      }>
    }>(GET_FIRST_PARTY_SUMMARY, { restaurantId }),
    hasuraQuery<{ restaurant_reviews: Array<{ palates: unknown }> }>(GET_FIRST_PARTY_PALATES, {
      restaurantUuid: uuid,
    }),
    getExternalReviewSummary(uuid),
    hasuraQuery<{
      restaurant_external_reviews: Array<{ rating: number; author_palates: string[] | null }>
    }>(GET_EXTERNAL_AUTHOR_PALATES, { restaurantUuid: uuid }),
  ])

  const fpSummary = fpSummaryResult.data?.restaurant_rating_summary?.[0]
  const fpCount = fpSummary?.overall_review_count ?? 0
  const fpAvg = fpSummary?.overall_rating_avg ?? null
  const fpPalateBreakdown = buildPalateBreakdown(fpPalatesResult.data?.restaurant_reviews ?? [])

  const external = externalSummary ?? emptyExternalSummary()
  const extCount = external.total_count ?? 0
  const extAvg = external.average_rating ?? null

  const W1 = 2.0
  const W2 = 1.0

  let weightedRating: number | null = null
  const fpWeight = fpCount * W1
  const extWeight = extCount * W2
  const totalWeight = fpWeight + extWeight

  if (totalWeight > 0 && fpAvg != null && extAvg != null) {
    weightedRating = Number(
      ((fpAvg * fpWeight + extAvg * extWeight) / totalWeight).toFixed(2),
    )
  } else if (totalWeight > 0 && fpAvg != null && extAvg == null) {
    weightedRating = Number(fpAvg.toFixed(2))
  } else if (totalWeight > 0 && fpAvg == null && extAvg != null) {
    weightedRating = Number(extAvg.toFixed(2))
  }

  const totalCount = fpCount + extCount
  const confidenceScore = Math.min(1, totalCount / 50)

  return {
    restaurant_id: uuid,
    first_party: {
      total_count: fpCount,
      average_rating: fpAvg,
      palate_breakdown: fpPalateBreakdown,
    },
    external: {
      total_count: extCount,
      average_rating: extAvg,
      platform_breakdown: external.platform_breakdown ?? {},
      language_breakdown: external.language_breakdown ?? {},
      palate_breakdown: external.palate_breakdown ?? {},
      author_palate_breakdown: buildAuthorPalateBreakdown(
        externalAuthorPalates.data?.restaurant_external_reviews ?? [],
      ),
      sentiment_breakdown: external.sentiment_breakdown ?? {},
    },
    combined: {
      weighted_rating: weightedRating,
      confidence_score: Number(confidenceScore.toFixed(2)),
      palate_signals: mergeCountMaps(fpPalateBreakdown, external.palate_breakdown ?? {}),
      dominant_language: dominantLanguage(external.language_breakdown ?? {}),
    },
  }
}

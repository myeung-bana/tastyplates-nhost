import { hasuraQuery } from './hasura'
import { getExternalReviewSummary } from './externalReviewQueries'
import type { ExternalReviewSummaryRow } from './externalReviewTypes'

const GET_FIRST_PARTY_SUMMARY = `
  query GetFirstPartySummary($uuid: uuid!) {
    restaurant_rating_summary(where: { restaurant: { uuid: { _eq: $uuid } } }, limit: 1) {
      overall_review_count
      overall_rating_avg
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

  const [fpSummaryResult, fpPalatesResult, externalSummary] = await Promise.all([
    hasuraQuery<{
      restaurant_rating_summary: Array<{
        overall_review_count: number
        overall_rating_avg: number | null
      }>
    }>(GET_FIRST_PARTY_SUMMARY, { uuid }),
    hasuraQuery<{ restaurant_reviews: Array<{ palates: unknown }> }>(GET_FIRST_PARTY_PALATES, {
      restaurantUuid: uuid,
    }),
    getExternalReviewSummary(uuid),
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

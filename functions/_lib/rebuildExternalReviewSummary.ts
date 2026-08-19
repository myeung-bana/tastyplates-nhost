import { hasuraAdmin, hasuraQuery } from './hasura'
import type { ExternalReviewSummaryRow } from './externalReviewTypes'
import { schedulePalateRatingSummaryRebuild } from './rebuildPalateRatingSummary'

const GET_REVIEWS_FOR_SUMMARY = `
  query ExternalReviewsForSummary($restaurantUuid: uuid!) {
    restaurant_external_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        is_flagged: { _eq: false }
      }
    ) {
      rating
      source_platform
      language
      palates
      sentiment
    }
  }
`

const GET_ALL_RESTAURANT_UUIDS_WITH_EXTERNAL = `
  query ExternalReviewRestaurantUuids {
    restaurant_external_reviews(distinct_on: restaurant_uuid) {
      restaurant_uuid
    }
  }
`

const UPSERT_EXTERNAL_REVIEW_SUMMARY = `
  mutation UpsertExternalReviewSummary($object: restaurant_external_review_summary_insert_input!) {
    insert_restaurant_external_review_summary_one(
      object: $object
      on_conflict: {
        constraint: restaurant_external_review_summary_pkey
        update_columns: [
          total_count
          average_rating
          platform_breakdown
          language_breakdown
          palate_breakdown
          sentiment_breakdown
          last_updated_at
        ]
      }
    ) {
      restaurant_uuid
    }
  }
`

type ReviewAggRow = {
  rating: number
  source_platform: string
  language: string | null
  palates: string[] | null
  sentiment: string | null
}

function incrementCount(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by
}

function aggregateReviews(rows: ReviewAggRow[]): Omit<ExternalReviewSummaryRow, 'restaurant_uuid' | 'last_updated_at'> {
  const platformStats: Record<string, { sum: number; count: number }> = {}
  const languageBreakdown: Record<string, number> = {}
  const palateBreakdown: Record<string, number> = {}
  const sentimentBreakdown: Record<string, number> = {}

  let ratingSum = 0
  let totalCount = 0

  for (const row of rows) {
    const rating = Number(row.rating)
    if (!Number.isFinite(rating) || rating <= 0) continue

    totalCount += 1
    ratingSum += rating

    const platform = row.source_platform || 'unknown'
    if (!platformStats[platform]) platformStats[platform] = { sum: 0, count: 0 }
    platformStats[platform].sum += rating
    platformStats[platform].count += 1

    if (row.language) incrementCount(languageBreakdown, row.language)
    if (row.sentiment) incrementCount(sentimentBreakdown, row.sentiment)

    for (const palate of row.palates ?? []) {
      const slug = String(palate).trim().toLowerCase()
      if (slug) incrementCount(palateBreakdown, slug)
    }
  }

  const platform_breakdown: Record<string, { count: number; avg: number }> = {}
  for (const [platform, stats] of Object.entries(platformStats)) {
    platform_breakdown[platform] = {
      count: stats.count,
      avg: Number((stats.sum / stats.count).toFixed(2)),
    }
  }

  return {
    total_count: totalCount,
    average_rating: totalCount > 0 ? Number((ratingSum / totalCount).toFixed(2)) : null,
    platform_breakdown,
    language_breakdown: languageBreakdown,
    palate_breakdown: palateBreakdown,
    sentiment_breakdown: sentimentBreakdown,
  }
}

export async function rebuildExternalReviewSummary(restaurantUuid: string): Promise<boolean> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return false

  const result = await hasuraQuery<{ restaurant_external_reviews: ReviewAggRow[] }>(
    GET_REVIEWS_FOR_SUMMARY,
    { restaurantUuid: uuid },
  )

  if (result.errors?.length) {
    console.error('[rebuildExternalReviewSummary]', result.errors)
    throw new Error(result.errors.map((e) => e.message).join(', '))
  }

  const rows = result.data?.restaurant_external_reviews ?? []
  const aggregated = aggregateReviews(rows)

  await hasuraAdmin(UPSERT_EXTERNAL_REVIEW_SUMMARY, {
    object: {
      restaurant_uuid: uuid,
      ...aggregated,
      last_updated_at: new Date().toISOString(),
    },
  })

  schedulePalateRatingSummaryRebuild(uuid, 'external')

  return true
}

export async function rebuildAllExternalReviewSummaries(): Promise<number> {
  const result = await hasuraQuery<{
    restaurant_external_reviews: Array<{ restaurant_uuid: string }>
  }>(GET_ALL_RESTAURANT_UUIDS_WITH_EXTERNAL)

  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join(', '))
  }

  const uuids = [
    ...new Set(
      (result.data?.restaurant_external_reviews ?? [])
        .map((r) => r.restaurant_uuid?.trim())
        .filter((u): u is string => Boolean(u)),
    ),
  ]

  let rebuilt = 0
  for (const uuid of uuids) {
    await rebuildExternalReviewSummary(uuid)
    rebuilt++
  }
  return rebuilt
}

/** Fire-and-forget rebuild — never throws to HTTP handlers. */
export function scheduleExternalReviewSummaryRebuild(restaurantUuid: string): void {
  const uuid = restaurantUuid?.trim()
  if (!uuid) return
  void rebuildExternalReviewSummary(uuid).catch((error) => {
    console.error('[rebuildExternalReviewSummary] scheduled rebuild failed:', uuid, error)
  })
}

export function scheduleExternalReviewSummaryRebuildMany(restaurantUuids: string[]): void {
  for (const uuid of new Set(restaurantUuids.map((u) => u.trim()).filter(Boolean))) {
    scheduleExternalReviewSummaryRebuild(uuid)
  }
}

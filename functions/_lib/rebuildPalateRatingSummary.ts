import { hasuraAdmin } from './hasura'
import { bucketEntriesByCuisine, PUBLIC_REVIEW_STATUS_WHERE } from './reviewPool'
import { loadReviewPool } from './reviewPoolLoader'

/**
 * Rating Model v3 — per-source palate rows in `restaurant_palate_rating_summary`.
 *
 * One row per (restaurant, cuisine, source) for every leaf cuisine and region that has reviewers.
 * Rows are UNWEIGHTED (raw `rating_sum`, smoothing over `review_count`): within one source every
 * review has the same weight. The native × 2 / scraped × 1 weighting is applied only in the
 * `restaurant_palate_rating_summary_combined` view (spec §7.5).
 *
 * Inclusion rules and reviewer identity come from the review pool, so native reviewers resolve
 * through `user_profiles.user_id` (v2 queried a non-existent `id` and silently skipped them).
 */

export const PALATE_RATING_GLOBAL_MEAN = 4.0
export const PALATE_RATING_CONFIDENCE_M = 5
export const PALATE_RATING_MIN_LEAF_REVIEWS = 3

export type PalateRatingSource = 'external' | 'first_party'


const GET_RESTAURANT_ID = `
  query GetRestaurantIdForPalateRebuild($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) { id }
  }
`

const DELETE_PALATE_SUMMARIES = `
  mutation DeletePalateSummaries($restaurantId: Int!, $source: String!) {
    delete_restaurant_palate_rating_summary(
      where: {
        restaurant_id: { _eq: $restaurantId }
        review_source: { _eq: $source }
      }
    ) {
      affected_rows
    }
  }
`

const INSERT_PALATE_SUMMARIES = `
  mutation InsertPalateSummaries($objects: [restaurant_palate_rating_summary_insert_input!]!) {
    insert_restaurant_palate_rating_summary(objects: $objects) {
      affected_rows
    }
  }
`

const GET_RESTAURANTS_WITH_EXTERNAL = `
  query RestaurantsWithExternalReviews {
    restaurant_external_reviews(where: { is_flagged: { _eq: false } }, distinct_on: restaurant_uuid) {
      restaurant_uuid
    }
  }
`

const GET_RESTAURANTS_WITH_FIRST_PARTY = `
  query RestaurantsWithFirstPartyReviews {
    restaurant_reviews(
      where: {
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        ${PUBLIC_REVIEW_STATUS_WHERE}
      }
      distinct_on: restaurant_uuid
    ) {
      restaurant_uuid
    }
  }
`

function bayesianWeighted(avg: number, count: number): number {
  return Number(
    (
      (avg * count + PALATE_RATING_GLOBAL_MEAN * PALATE_RATING_CONFIDENCE_M) /
      (count + PALATE_RATING_CONFIDENCE_M)
    ).toFixed(4),
  )
}

async function resolveRestaurantId(restaurantUuid: string): Promise<number | null> {
  const data = await hasuraAdmin<{ restaurants: Array<{ id: number }> }>(GET_RESTAURANT_ID, {
    uuid: restaurantUuid.trim(),
  })
  return data.restaurants?.[0]?.id ?? null
}

export async function rebuildPalateRatingSummary(
  restaurantUuid: string,
  source: PalateRatingSource,
): Promise<{ rows_upserted: number }> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return { rows_upserted: 0 }

  const [restaurantId, pool] = await Promise.all([
    resolveRestaurantId(uuid),
    loadReviewPool({ restaurantUuids: [uuid] }),
  ])

  if (!restaurantId) {
    console.warn('[rebuildPalateRatingSummary] Restaurant not found:', uuid)
    return { rows_upserted: 0 }
  }

  const buckets = bucketEntriesByCuisine(pool.entries.filter((entry) => entry.source === source))

  await hasuraAdmin(DELETE_PALATE_SUMMARIES, { restaurantId, source })

  const versionTs = Math.floor(Date.now() / 1000)
  const now = new Date().toISOString()
  const objects = [...buckets.entries()].map(([cuisineId, bucket]) => {
    const avg = bucket.sum / bucket.count
    return {
      restaurant_id: restaurantId,
      cuisine_id: cuisineId,
      review_source: source,
      review_count: bucket.count,
      rating_sum: Number(bucket.sum.toFixed(4)),
      rating_avg: Number(avg.toFixed(2)),
      rating_weighted: bayesianWeighted(avg, bucket.count),
      reviewer_count: bucket.reviewers.size,
      review_version: versionTs,
      updated_at: now,
    }
  })

  if (objects.length > 0) {
    await hasuraAdmin(INSERT_PALATE_SUMMARIES, { objects })
  }

  return { rows_upserted: objects.length }
}

export async function rebuildAllPalateRatingSummaries(
  source?: PalateRatingSource,
): Promise<number> {
  const sources: PalateRatingSource[] = source ? [source] : ['external', 'first_party']
  let rebuilt = 0

  for (const reviewSource of sources) {
    const query =
      reviewSource === 'external' ? GET_RESTAURANTS_WITH_EXTERNAL : GET_RESTAURANTS_WITH_FIRST_PARTY

    const data = await hasuraAdmin<{
      restaurant_external_reviews?: Array<{ restaurant_uuid: string | null }>
      restaurant_reviews?: Array<{ restaurant_uuid: string | null }>
    }>(query)

    const rows =
      reviewSource === 'external' ? data.restaurant_external_reviews : data.restaurant_reviews
    const uuids = [
      ...new Set(
        (rows ?? [])
          .map((row) => row.restaurant_uuid?.trim())
          .filter((uuid): uuid is string => Boolean(uuid)),
      ),
    ]

    for (const uuid of uuids) {
      await rebuildPalateRatingSummary(uuid, reviewSource)
      rebuilt++
    }
  }

  return rebuilt
}

export function schedulePalateRatingSummaryRebuild(
  restaurantUuid: string,
  source: PalateRatingSource,
): void {
  const uuid = restaurantUuid?.trim()
  if (!uuid) return
  void rebuildPalateRatingSummary(uuid, source).catch((error) => {
    console.error('[rebuildPalateRatingSummary] scheduled rebuild failed:', uuid, source, error)
  })
}

export function schedulePalateRatingSummaryRebuildBoth(restaurantUuid: string): void {
  schedulePalateRatingSummaryRebuild(restaurantUuid, 'external')
  schedulePalateRatingSummaryRebuild(restaurantUuid, 'first_party')
}

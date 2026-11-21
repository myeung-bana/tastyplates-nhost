import { hasuraAdmin } from './hasura'
import {
  everyone,
  type PoolScore,
  resolveRestaurantCuisines,
  reviewerMatchesRestaurantCuisines,
  scorePool,
} from './reviewPool'
import { loadReviewPool } from './reviewPoolLoader'
import { schedulePalateRatingSummaryRebuildBoth } from './rebuildPalateRatingSummary'

/**
 * Rating Model v3 — Overall + Authentic for one restaurant.
 *
 * Both come from the review pool (native × 2 + scraped × 1, no Google aggregate) via `scorePool`.
 * Column meanings in `restaurant_rating_summary`:
 *   *_review_count    number of reviews
 *   *_rating_sum      weighted sum (Σ weight × rating)
 *   *_rating_avg      weighted average — shown to users
 *   *_rating_weighted Bayesian ranking value in weight units — sorting only
 */

const GET_RESTAURANT_FOR_REBUILD = `
  query RebuildGetRestaurant($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      id
      cuisines
    }
  }
`

const UPSERT_RATING_SUMMARY = `
  mutation RebuildUpsertRatingSummary($object: restaurant_rating_summary_insert_input!) {
    insert_restaurant_rating_summary_one(
      object: $object
      on_conflict: {
        constraint: restaurant_rating_summary_pkey
        update_columns: [
          overall_review_count
          overall_rating_sum
          overall_rating_avg
          overall_rating_weighted
          authentic_review_count
          authentic_rating_sum
          authentic_rating_avg
          authentic_rating_weighted
          review_version
          updated_at
        ]
      }
    ) {
      restaurant_id
    }
  }
`

const UPSERT_CUISINE_RATING_SUMMARY = `
  mutation RebuildUpsertCuisineRatingSummaries($objects: [restaurant_cuisine_rating_summary_insert_input!]!) {
    insert_restaurant_cuisine_rating_summary(
      objects: $objects
      on_conflict: {
        constraint: restaurant_cuisine_rating_summary_pkey
        update_columns: [
          search_review_count
          search_rating_sum
          search_rating_avg
          search_rating_weighted
          authentic_review_count
          authentic_rating_sum
          authentic_rating_avg
          authentic_rating_weighted
          review_version
          updated_at
        ]
      }
    ) {
      affected_rows
    }
  }
`

const UPDATE_RESTAURANT_RATING = `
  mutation RebuildUpdateRestaurantRating($uuid: uuid!, $average_rating: numeric, $ratings_count: Int!) {
    update_restaurants(
      where: { uuid: { _eq: $uuid } }
      _set: { average_rating: $average_rating, ratings_count: $ratings_count }
    ) {
      affected_rows
    }
  }
`

export type RatingSummaryRebuildResult = {
  restaurant_uuid: string
  restaurant_id: number
  overall: PoolScore
  authentic: PoolScore
}

export type RatingSummaryComputation = RatingSummaryRebuildResult & {
  /** The restaurant's valid cuisine ids (deleted ids dropped); keys for the legacy per-cuisine table. */
  cuisine_ids: number[]
}

/** Compute Overall + Authentic without writing anything (used by dry runs and the rebuild). */
export async function computeRatingSummary(
  restaurantUuid: string,
): Promise<RatingSummaryComputation | null> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return null

  const [restaurantData, pool] = await Promise.all([
    hasuraAdmin<{ restaurants: Array<{ id: number; cuisines: unknown }> }>(
      GET_RESTAURANT_FOR_REBUILD,
      { uuid },
    ),
    loadReviewPool({ restaurantUuids: [uuid] }),
  ])

  const restaurant = restaurantData.restaurants?.[0]
  if (!restaurant) return null

  const cuisines = resolveRestaurantCuisines(restaurant.cuisines, pool.taxonomy)
  const hasCuisines = cuisines.leafIds.size > 0 || cuisines.regionIds.size > 0

  return {
    restaurant_uuid: uuid,
    restaurant_id: restaurant.id,
    overall: scorePool(pool.entries, everyone),
    authentic: hasCuisines
      ? scorePool(pool.entries, reviewerMatchesRestaurantCuisines(cuisines))
      : scorePool([]),
    cuisine_ids: [...cuisines.leafIds, ...cuisines.regionIds],
  }
}

function summaryColumns(prefix: 'overall' | 'authentic' | 'search', score: PoolScore) {
  return {
    [`${prefix}_review_count`]: score.review_count,
    [`${prefix}_rating_sum`]: score.weighted_sum,
    [`${prefix}_rating_avg`]: score.display_avg,
    [`${prefix}_rating_weighted`]: score.ranking_value,
  }
}

/**
 * Recompute Overall + Authentic for one restaurant and persist them.
 * Throws on query/write errors; returns null when the restaurant doesn't exist.
 * Safe to call concurrently; upserts are idempotent.
 */
export async function rebuildRatingSummary(
  restaurantUuid: string,
): Promise<RatingSummaryRebuildResult | null> {
  const computed = await computeRatingSummary(restaurantUuid)
  if (!computed) {
    console.warn('[rebuildRatingSummary] Restaurant not found:', restaurantUuid)
    return null
  }

  const { restaurant_uuid: uuid, restaurant_id: restaurantId, overall, authentic, cuisine_ids: cuisineIds } = computed
  const versionTs = Math.floor(Date.now() / 1000)
  const now = new Date().toISOString()

  await hasuraAdmin(UPSERT_RATING_SUMMARY, {
    object: {
      restaurant_id: restaurantId,
      ...summaryColumns('overall', overall),
      ...summaryColumns('authentic', authentic),
      review_version: versionTs,
      updated_at: now,
    },
  })

  await hasuraAdmin(UPDATE_RESTAURANT_RATING, {
    uuid,
    average_rating: overall.display_avg,
    ratings_count: overall.review_count,
  })

  if (cuisineIds.length > 0) {
    try {
      await hasuraAdmin(UPSERT_CUISINE_RATING_SUMMARY, {
        objects: cuisineIds.map((cuisineId) => ({
          restaurant_id: restaurantId,
          cuisine_id: cuisineId,
          ...summaryColumns('search', overall),
          ...summaryColumns('authentic', authentic),
          review_version: versionTs,
          updated_at: now,
        })),
      })
    } catch (error) {
      console.warn('[rebuildRatingSummary] Cuisine summary upsert error (non-fatal):', error)
    }
  }

  // Palate rows read the same pool; keep them in step with every Overall/Authentic rebuild.
  schedulePalateRatingSummaryRebuildBoth(uuid)

  return { restaurant_uuid: uuid, restaurant_id: restaurantId, overall, authentic }
}

/** Fire-and-forget rebuild — never throws to HTTP handlers. */
export function scheduleRatingSummaryRebuild(restaurantUuid: string): void {
  const uuid = restaurantUuid?.trim()
  if (!uuid) return
  void rebuildRatingSummary(uuid).catch((error) => {
    console.error('[rebuildRatingSummary] scheduled rebuild failed:', uuid, error)
  })
}

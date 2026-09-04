import { hasuraAdmin, hasuraQuery } from './hasura'
import {
  applyGoogleRatingAggregate,
  fetchGoogleRatingAggregateForRestaurant,
} from './googleRatingPrior'
import { hasMatchingPalates, normalizePalates } from './palateUtils'
import { buildAuthorProfileMap } from './review-enrichment'
import { schedulePalateRatingSummaryRebuild } from './rebuildPalateRatingSummary'

const GLOBAL_MEAN = 4.0
const CONFIDENCE_M = 5

function bayesianWeighted(avg: number, count: number): number {
  return Number((((avg * count) + (GLOBAL_MEAN * CONFIDENCE_M)) / (count + CONFIDENCE_M)).toFixed(4))
}

const GET_REVIEWS_FOR_REBUILD = `
  query RebuildGetReviews($restaurantUuid: uuid!) {
    restaurant_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
      }
    ) {
      author_id
      rating
      status
      palates
    }
  }
`

const GET_EXTERNAL_REVIEWS_FOR_REBUILD = `
  query RebuildGetExternalReviews($restaurantUuid: uuid!) {
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

const GET_RESTAURANT_FOR_REBUILD = `
  query RebuildGetRestaurant($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      id
      palates
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

function extractCuisineIds(cuisines: unknown): number[] {
  if (!cuisines) return []
  const arr = Array.isArray(cuisines)
    ? cuisines
    : (() => {
        try {
          return JSON.parse(String(cuisines)) as unknown[]
        } catch {
          return []
        }
      })()
  return (arr as unknown[])
    .map((c) => {
      if (typeof c === 'object' && c !== null && 'id' in c) return Number((c as { id: unknown }).id)
      return NaN
    })
    .filter((id) => !isNaN(id) && id > 0)
}

function extractReviewPalates(palates: unknown): string[] {
  if (!palates) return []
  if (Array.isArray(palates)) {
    if (palates.every((p) => typeof p === 'string')) {
      return palates.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
    }
    return palates
      .map((p) =>
        typeof p === 'string'
          ? p
          : String((p as { slug?: string; name?: string })?.slug ?? (p as { name?: string })?.name ?? ''),
      )
      .filter(Boolean)
      .map((p) => p.trim().toLowerCase())
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

type ReviewRow = {
  author_id: string | null
  rating: number | null
  status: string
  palates: unknown
}

/**
 * Recompute rating aggregates for one restaurant and persist them.
 * Safe to call concurrently; upsert is idempotent.
 */
export async function rebuildRatingSummary(restaurantUuid: string): Promise<void> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return

  const [reviewsResult, restaurantResult, externalReviewsResult] = await Promise.all([
    hasuraQuery<{ restaurant_reviews: ReviewRow[] }>(GET_REVIEWS_FOR_REBUILD, {
      restaurantUuid: uuid,
    }),
    hasuraQuery<{ restaurants: Array<{ id: number; palates: unknown; cuisines: unknown }> }>(
      GET_RESTAURANT_FOR_REBUILD,
      { uuid },
    ),
    hasuraQuery<{
      restaurant_external_reviews: Array<{
        rating: number
        author_palates: string[] | null
      }>
    }>(GET_EXTERNAL_REVIEWS_FOR_REBUILD, { restaurantUuid: uuid }),
  ])

  if (reviewsResult.errors?.length) {
    console.error('[rebuildRatingSummary] Review query error:', reviewsResult.errors)
    return
  }
  if (restaurantResult.errors?.length) {
    console.error('[rebuildRatingSummary] Restaurant query error:', restaurantResult.errors)
    return
  }
  if (externalReviewsResult.errors?.length) {
    console.error('[rebuildRatingSummary] External review query error:', externalReviewsResult.errors)
    return
  }

  const restaurant = restaurantResult.data?.restaurants?.[0]
  if (!restaurant) {
    console.warn('[rebuildRatingSummary] Restaurant not found:', uuid)
    return
  }

  const reviews = reviewsResult.data?.restaurant_reviews ?? []
  const googleAggregate = await fetchGoogleRatingAggregateForRestaurant(uuid)
  const authorIds = reviews
    .map((r) => r.author_id?.trim())
    .filter((id): id is string => Boolean(id))
  const authorProfileMap = await buildAuthorProfileMap(authorIds)

  const restaurantTaxonomy = [
    ...normalizePalates(restaurant.palates),
    ...normalizePalates(restaurant.cuisines),
  ]

  const overall = { sum: 0, count: 0 }
  const authentic = { sum: 0, count: 0 }

  for (const review of reviews) {
    if (review.status !== 'approved') continue
    const rating = Number(review.rating) || 0
    if (rating <= 0) continue

    overall.sum += rating
    overall.count += 1

    const authorKey = review.author_id?.trim().toLowerCase() ?? ''
    const profilePalates = authorKey ? authorProfileMap.get(authorKey)?.palates : null
    const authorPalates = extractReviewPalates(profilePalates)
    const reviewerPalates =
      authorPalates.length > 0 ? authorPalates : extractReviewPalates(review.palates)

    if (restaurantTaxonomy.length > 0 && hasMatchingPalates(restaurantTaxonomy, reviewerPalates)) {
      authentic.sum += rating
      authentic.count += 1
    }
  }

  for (const review of externalReviewsResult.data?.restaurant_external_reviews ?? []) {
    const rating = Number(review.rating) || 0
    if (rating <= 0) continue

    const reviewerPalates = (review.author_palates ?? [])
      .map((slug) => String(slug).trim().toLowerCase())
      .filter(Boolean)

    if (restaurantTaxonomy.length > 0 && hasMatchingPalates(restaurantTaxonomy, reviewerPalates)) {
      authentic.sum += rating
      authentic.count += 1
    }
  }

  applyGoogleRatingAggregate(overall, googleAggregate)

  const overallAvg = overall.count > 0 ? overall.sum / overall.count : null
  const overallWeighted = overallAvg !== null ? bayesianWeighted(overallAvg, overall.count) : null
  const authenticAvg = authentic.count > 0 ? authentic.sum / authentic.count : null
  const authenticWeighted =
    authenticAvg !== null ? bayesianWeighted(authenticAvg, authentic.count) : null

  try {
    await hasuraAdmin(UPSERT_RATING_SUMMARY, {
      object: {
        restaurant_id: restaurant.id,
        overall_review_count: overall.count,
        overall_rating_sum: Number(overall.sum.toFixed(4)),
        overall_rating_avg: overallAvg !== null ? Number(overallAvg.toFixed(4)) : null,
        overall_rating_weighted: overallWeighted,
        authentic_review_count: authentic.count,
        authentic_rating_sum: Number(authentic.sum.toFixed(4)),
        authentic_rating_avg: authenticAvg !== null ? Number(authenticAvg.toFixed(4)) : null,
        authentic_rating_weighted: authenticWeighted,
        review_version: Math.floor(Date.now() / 1000),
        updated_at: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error('[rebuildRatingSummary] Upsert summary error:', error)
  }

  try {
    await hasuraAdmin(UPDATE_RESTAURANT_RATING, {
      uuid,
      average_rating: overallAvg !== null ? Number(overallAvg.toFixed(4)) : null,
      ratings_count: overall.count,
    })
  } catch (error) {
    console.error('[rebuildRatingSummary] Update restaurant rating error:', error)
  }

  const cuisineIds = extractCuisineIds(restaurant.cuisines)
  if (cuisineIds.length > 0) {
    const versionTs = Math.floor(Date.now() / 1000)
    const cuisineObjects = cuisineIds.map((cuisineId) => ({
      restaurant_id: restaurant.id,
      cuisine_id: cuisineId,
      search_review_count: overall.count,
      search_rating_sum: Number(overall.sum.toFixed(4)),
      search_rating_avg: overallAvg !== null ? Number(overallAvg.toFixed(4)) : null,
      search_rating_weighted: overallWeighted,
      authentic_review_count: authentic.count,
      authentic_rating_sum: Number(authentic.sum.toFixed(4)),
      authentic_rating_avg: authenticAvg !== null ? Number(authenticAvg.toFixed(4)) : null,
      authentic_rating_weighted: authenticWeighted,
      review_version: versionTs,
      updated_at: new Date().toISOString(),
    }))

    try {
      await hasuraAdmin(UPSERT_CUISINE_RATING_SUMMARY, { objects: cuisineObjects })
    } catch (error) {
      console.warn('[rebuildRatingSummary] Cuisine summary upsert error (non-fatal):', error)
    }
  }

  schedulePalateRatingSummaryRebuild(uuid, 'first_party')
}

/** Fire-and-forget rebuild — never throws to HTTP handlers. */
export function scheduleRatingSummaryRebuild(restaurantUuid: string): void {
  const uuid = restaurantUuid?.trim()
  if (!uuid) return
  void rebuildRatingSummary(uuid).catch((error) => {
    console.error('[rebuildRatingSummary] scheduled rebuild failed:', uuid, error)
  })
}

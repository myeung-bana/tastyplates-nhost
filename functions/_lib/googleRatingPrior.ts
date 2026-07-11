import { hasuraQuery } from './hasura'

const GET_GOOGLE_RATING_BY_RESTAURANT_UUID = `
  query GetGoogleRatingByRestaurantUuid($uuid: uuid!) {
    google_place_cache(
      where: { tastyplates_restaurant_uuid: { _eq: $uuid }, google_rating: { _gt: 0 } }
      limit: 1
    ) {
      google_rating
      user_ratings_total
    }
  }
`

const GET_GOOGLE_RATING_PRIORS = `
  query GetGoogleRatingPriors {
    google_place_cache(
      where: {
        tastyplates_restaurant_uuid: { _is_null: false }
        google_rating: { _gt: 0 }
      }
      limit: 5000
    ) {
      tastyplates_restaurant_uuid
      google_rating
      user_ratings_total
    }
  }
`

export type RatingBucket = { sum: number; count: number }

export type GoogleRatingAggregate = {
  rating: number
  reviewCount: number
}

/** Normalize Google star rating to a positive finite number, or null. */
export function normalizeGoogleRatingPrior(value: unknown): number | null {
  const rating = Number(value)
  if (!Number.isFinite(rating) || rating <= 0 || rating > 5) return null
  return Number(rating.toFixed(4))
}

/** Normalize Google `user_ratings_total` for aggregate scoring. */
export function normalizeGoogleReviewCount(value: unknown): number | null {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) return null
  return Math.floor(count)
}

export function toGoogleRatingAggregate(
  ratingRaw: unknown,
  reviewCountRaw: unknown,
): GoogleRatingAggregate | null {
  const rating = normalizeGoogleRatingPrior(ratingRaw)
  const reviewCount = normalizeGoogleReviewCount(reviewCountRaw)
  if (rating === null || reviewCount === null) return null
  return { rating, reviewCount }
}

/**
 * Fold Google aggregate into a rating bucket without storing individual Google reviews.
 * 1k Google reviews at 4.5 → sum += 4500, count += 1000.
 */
export function applyGoogleRatingAggregate(
  bucket: RatingBucket,
  google: GoogleRatingAggregate | null | undefined,
): void {
  if (!google || google.rating <= 0 || google.reviewCount <= 0) return
  bucket.sum += google.rating * google.reviewCount
  bucket.count += google.reviewCount
}

/** Google aggregate for one linked TP restaurant (cache lookup). */
export async function fetchGoogleRatingAggregateForRestaurant(
  restaurantUuid: string,
): Promise<GoogleRatingAggregate | null> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return null

  try {
    type Result = {
      google_place_cache: Array<{
        google_rating: number | null
        user_ratings_total: number | null
      }>
    }
    const result = await hasuraQuery<Result>(GET_GOOGLE_RATING_BY_RESTAURANT_UUID, { uuid })
    if (result.errors?.length) return null
    const row = result.data?.google_place_cache?.[0]
    return toGoogleRatingAggregate(row?.google_rating, row?.user_ratings_total)
  } catch {
    return null
  }
}

/** Map `restaurant_uuid` → Google aggregate for preference stats merge. */
export async function fetchGoogleRatingAggregateMap(): Promise<Map<string, GoogleRatingAggregate>> {
  const map = new Map<string, GoogleRatingAggregate>()
  try {
    type Row = {
      tastyplates_restaurant_uuid: string | null
      google_rating: number | null
      user_ratings_total: number | null
    }
    type Result = { google_place_cache: Row[] }
    const result = await hasuraQuery<Result>(GET_GOOGLE_RATING_PRIORS, {})
    if (result.errors?.length) return map

    for (const row of result.data?.google_place_cache ?? []) {
      const uuid = row.tastyplates_restaurant_uuid?.trim()
      const aggregate = toGoogleRatingAggregate(row.google_rating, row.user_ratings_total)
      if (!uuid || !aggregate) continue
      map.set(uuid, aggregate)
    }
  } catch {
    return map
  }
  return map
}

/** Merge Google aggregates into a per-restaurant accumulator (Search / Shared stats). */
export function mergeGoogleRatingAggregatesIntoAccumulator(
  acc: Map<string, RatingBucket>,
  aggregateMap: Map<string, GoogleRatingAggregate>,
): void {
  for (const [uuid, aggregate] of aggregateMap.entries()) {
    const cur = acc.get(uuid) ?? { sum: 0, count: 0 }
    applyGoogleRatingAggregate(cur, aggregate)
    acc.set(uuid, cur)
  }
}

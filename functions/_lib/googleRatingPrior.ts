import { hasuraQuery } from './hasura'

const GET_GOOGLE_RATING_BY_RESTAURANT_UUID = `
  query GetGoogleRatingByRestaurantUuid($uuid: uuid!) {
    google_place_cache(
      where: { tastyplates_restaurant_uuid: { _eq: $uuid }, google_rating: { _gt: 0 } }
      limit: 1
    ) {
      google_rating
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
    }
  }
`

export type RatingBucket = { sum: number; count: number }

/** Normalize Google star rating to a positive finite number, or null. */
export function normalizeGoogleRatingPrior(value: unknown): number | null {
  const rating = Number(value)
  if (!Number.isFinite(rating) || rating <= 0 || rating > 5) return null
  return Number(rating.toFixed(4))
}

/**
 * Add exactly one synthetic review entry from Google aggregate rating.
 * 1k Google reviews at 4.5 → one prior entry at 4.5, not 1000 entries.
 */
export function applyGoogleRatingPrior(
  bucket: RatingBucket,
  googleRating: number | null | undefined,
): void {
  const rating = normalizeGoogleRatingPrior(googleRating)
  if (rating === null) return
  bucket.sum += rating
  bucket.count += 1
}

/** Google rating prior for one linked TP restaurant (cache lookup). */
export async function fetchGoogleRatingPriorForRestaurant(
  restaurantUuid: string,
): Promise<number | null> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return null

  try {
    type Result = { google_place_cache: Array<{ google_rating: number | null }> }
    const result = await hasuraQuery<Result>(GET_GOOGLE_RATING_BY_RESTAURANT_UUID, { uuid })
    if (result.errors?.length) return null
    const row = result.data?.google_place_cache?.[0]
    return normalizeGoogleRatingPrior(row?.google_rating)
  } catch {
    return null
  }
}

/** Map `restaurant_uuid` → Google rating prior for preference stats merge. */
export async function fetchGoogleRatingPriorMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    type Row = { tastyplates_restaurant_uuid: string | null; google_rating: number | null }
    type Result = { google_place_cache: Row[] }
    const result = await hasuraQuery<Result>(GET_GOOGLE_RATING_PRIORS, {})
    if (result.errors?.length) return map

    for (const row of result.data?.google_place_cache ?? []) {
      const uuid = row.tastyplates_restaurant_uuid?.trim()
      const rating = normalizeGoogleRatingPrior(row.google_rating)
      if (!uuid || rating === null) continue
      map.set(uuid, rating)
    }
  } catch {
    return map
  }
  return map
}

/** Merge Google priors into a per-restaurant accumulator (Search / Shared stats). */
export function mergeGoogleRatingPriorsIntoAccumulator(
  acc: Map<string, RatingBucket>,
  priorMap: Map<string, number>,
): void {
  for (const [uuid, rating] of priorMap.entries()) {
    const cur = acc.get(uuid) ?? { sum: 0, count: 0 }
    applyGoogleRatingPrior(cur, rating)
    acc.set(uuid, cur)
  }
}

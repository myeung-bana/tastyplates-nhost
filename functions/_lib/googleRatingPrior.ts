/**
 * Google rating helpers for Google-only place data.
 *
 * Rating Model v3 removed the Google aggregate block from every TastyPlates score; Google is
 * represented only by scraped Google Maps reviews in the review pool (see reviewPool.ts).
 */

/** Normalize Google star rating to a positive finite number, or null. */
export function normalizeGoogleRatingPrior(value: unknown): number | null {
  const rating = Number(value)
  if (!Number.isFinite(rating) || rating <= 0 || rating > 5) return null
  return Number(rating.toFixed(4))
}

/**
 * Rating Model v3 review pool (pure logic — no I/O).
 *
 * Every client-facing score is computed from one pool per restaurant, with one formula.
 * Scores differ only in which reviewers they include. This module is the only place that
 * applies inclusion rules, weights and reviewer palate (identity) resolution.
 *
 * Spec: documentation/ratings/rating-model-v3.md (§3–§5) at the workspace root.
 * Loading from Hasura lives in `reviewPoolLoader.ts`, so this file stays testable.
 *
 * Palate here always means ethnic identity (`restaurant_cuisines`). Taste data
 * (`restaurant_palates`, `restaurants.palates`, scraped-review `palates`) never enters the pool.
 */

export type PoolSource = 'first_party' | 'external'

export const NATIVE_WEIGHT = 2
export const SCRAPED_WEIGHT = 1
export const POOL_GLOBAL_MEAN = 4.0
export const POOL_CONFIDENCE_M = 5

/** Native review statuses that never count. Everything else (approved, pending) is public. */
export const EXCLUDED_NATIVE_STATUSES: ReadonlySet<string> = new Set(['draft', 'rejected'])

export type CuisineRow = {
  id: number
  slug: string
  name: string
  parent_id: number | null
}

export type CuisineTaxonomy = {
  byId: Map<number, CuisineRow>
  /** Normalized slug → row (leaves and regions). */
  bySlug: Map<string, CuisineRow>
}

/** Reviewer identity resolved against the taxonomy. A reviewer palate is always a leaf cuisine. */
export type ReviewerIdentity = {
  leafIds: ReadonlySet<number>
  /** Regions of the reviewer's leaf palates. */
  regionIds: ReadonlySet<number>
}

export type PoolEntry = {
  source: PoolSource
  restaurantUuid: string
  rating: number
  weight: number
  /** Distinct-reviewer key (author id, scraped author id/name, or review id). */
  reviewerKey: string
  identity: ReviewerIdentity
  /** When the review was written (native created_at; scraped reviewed_at, else ingested_at). */
  reviewedAt: string | null
}

export type NativeReviewRow = {
  id: string
  restaurant_uuid: string | null
  rating: number | string | null
  status: string | null
  author_id: string | null
  /** Identity saved on the review at write time (fallback when the profile has none). */
  palates: unknown
  deleted_at?: string | null
  parent_review_id?: string | null
  created_at?: string | null
}

export type ScrapedReviewRow = {
  id: string
  restaurant_uuid: string | null
  rating: number | string | null
  is_flagged?: boolean | null
  author_palates: unknown
  source_author_id?: string | null
  source_author_name?: string | null
  reviewed_at?: string | null
  ingested_at?: string | null
}

export type PoolScore = {
  /** Plain weighted average, shown to users. Null when no reviews pass the filter. */
  display_avg: number | null
  /** Bayesian-smoothed value in weight units, used for sorting only. */
  ranking_value: number | null
  /** Number of reviews (not weight). Unlock thresholds use this. */
  review_count: number
  total_weight: number
  weighted_sum: number
  /** Distinct reviewers among the counted reviews. */
  reviewer_count: number
  native_count: number
  scraped_count: number
  /** Plain average of the native reviews counted (admin breakdown). */
  native_avg: number | null
  /** Plain average of the scraped reviews counted (admin breakdown). */
  scraped_avg: number | null
}

export type ReviewerFilter = (entry: PoolEntry) => boolean

// ---------------------------------------------------------------------------
// Taxonomy + identity
// ---------------------------------------------------------------------------

export function normalizeCuisineSlug(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
}

export function buildCuisineTaxonomy(rows: CuisineRow[]): CuisineTaxonomy {
  const byId = new Map<number, CuisineRow>()
  const bySlug = new Map<string, CuisineRow>()
  for (const row of rows) {
    byId.set(row.id, row)
    bySlug.set(normalizeCuisineSlug(row.slug), row)
  }
  return { byId, bySlug }
}

/** Flatten a stored palate list (string[], {slug|name}[], JSON string or `a|b`) to raw values. */
export function extractPalateValues(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item
        if (typeof item === 'object' && item !== null) {
          const obj = item as { slug?: unknown; name?: unknown }
          return String(obj.slug ?? obj.name ?? '')
        }
        return String(item)
      })
      .map((v) => v.trim())
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    try {
      return extractPalateValues(JSON.parse(trimmed) as unknown)
    } catch {
      return trimmed
        .split(/[|,]/)
        .map((part) => part.trim())
        .filter(Boolean)
    }
  }
  return []
}

/**
 * Resolve palate values to leaf cuisines (exact slug match after normalizing).
 * Values that are regions or unknown are ignored: a reviewer's palate is a leaf cuisine.
 */
export function resolveReviewerIdentity(raw: unknown, taxonomy: CuisineTaxonomy): ReviewerIdentity {
  const leafIds = new Set<number>()
  const regionIds = new Set<number>()
  for (const value of extractPalateValues(raw)) {
    const row = taxonomy.bySlug.get(normalizeCuisineSlug(value))
    if (!row || row.parent_id == null) continue
    leafIds.add(row.id)
    regionIds.add(row.parent_id)
  }
  return { leafIds, regionIds }
}

export function hasIdentity(identity: ReviewerIdentity): boolean {
  return identity.leafIds.size > 0
}

/**
 * A restaurant's cuisines (`restaurants.cuisines` JSONB: `{ id, slug, name }[]`), resolved by id,
 * falling back to slug. Deleted ids are dropped. Used for Authentic.
 */
export function resolveRestaurantCuisines(
  raw: unknown,
  taxonomy: CuisineTaxonomy,
): { leafIds: Set<number>; regionIds: Set<number> } {
  const leafIds = new Set<number>()
  const regionIds = new Set<number>()
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(raw) as unknown
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        })()
      : []

  for (const item of items) {
    let row: CuisineRow | undefined
    if (typeof item === 'object' && item !== null) {
      const obj = item as { id?: unknown; slug?: unknown; name?: unknown }
      const id = Number(obj.id)
      if (Number.isFinite(id) && id > 0) row = taxonomy.byId.get(id)
      if (!row && obj.slug != null) row = taxonomy.bySlug.get(normalizeCuisineSlug(obj.slug))
    } else if (typeof item === 'string') {
      row = taxonomy.bySlug.get(normalizeCuisineSlug(item))
    }
    if (!row) continue
    if (row.parent_id == null) regionIds.add(row.id)
    else leafIds.add(row.id)
  }
  return { leafIds, regionIds }
}

// ---------------------------------------------------------------------------
// Inclusion rules → pool entries
// ---------------------------------------------------------------------------

function toRating(value: number | string | null | undefined): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null
  return n
}

/** §3: top-level, not deleted, status not draft/rejected, rating in range. */
export function isNativeReviewIncluded(row: NativeReviewRow): boolean {
  if (row.deleted_at) return false
  if (row.parent_review_id) return false
  if (row.status && EXCLUDED_NATIVE_STATUSES.has(row.status)) return false
  if (!row.restaurant_uuid?.trim()) return false
  return toRating(row.rating) != null
}

/** §3: not flagged, rating in range. */
export function isScrapedReviewIncluded(row: ScrapedReviewRow): boolean {
  if (row.is_flagged) return false
  if (!row.restaurant_uuid?.trim()) return false
  return toRating(row.rating) != null
}

/**
 * Build pool entries.
 * Native identity: author's `user_profiles.palates` (keyed by `user_id`), else the review's saved palates.
 * Scraped identity: `author_palates`.
 */
export function buildPoolEntries(input: {
  native: NativeReviewRow[]
  scraped: ScrapedReviewRow[]
  /** user_id (lowercased) → user_profiles.palates */
  profilePalatesByUserId: Map<string, unknown>
  taxonomy: CuisineTaxonomy
}): PoolEntry[] {
  const entries: PoolEntry[] = []

  for (const row of input.native) {
    if (!isNativeReviewIncluded(row)) continue
    const authorKey = row.author_id?.trim().toLowerCase() ?? ''
    const fromProfile = authorKey
      ? resolveReviewerIdentity(input.profilePalatesByUserId.get(authorKey), input.taxonomy)
      : null
    const identity =
      fromProfile && hasIdentity(fromProfile)
        ? fromProfile
        : resolveReviewerIdentity(row.palates, input.taxonomy)

    entries.push({
      source: 'first_party',
      restaurantUuid: row.restaurant_uuid!.trim(),
      rating: toRating(row.rating)!,
      weight: NATIVE_WEIGHT,
      reviewerKey: authorKey ? `fp:${authorKey}` : `fp-review:${row.id}`,
      identity,
      reviewedAt: row.created_at ?? null,
    })
  }

  for (const row of input.scraped) {
    if (!isScrapedReviewIncluded(row)) continue
    const authorKey =
      row.source_author_id?.trim() || row.source_author_name?.trim().toLowerCase() || ''
    entries.push({
      source: 'external',
      restaurantUuid: row.restaurant_uuid!.trim(),
      rating: toRating(row.rating)!,
      weight: SCRAPED_WEIGHT,
      reviewerKey: authorKey ? `ext:${authorKey}` : `ext-review:${row.id}`,
      identity: resolveReviewerIdentity(row.author_palates, input.taxonomy),
      reviewedAt: row.reviewed_at ?? row.ingested_at ?? null,
    })
  }

  return entries
}

// ---------------------------------------------------------------------------
// Formula (§4)
// ---------------------------------------------------------------------------

export function rankingValue(weightedSum: number, totalWeight: number): number {
  return (weightedSum + POOL_GLOBAL_MEAN * POOL_CONFIDENCE_M) / (totalWeight + POOL_CONFIDENCE_M)
}

/** Score the entries that pass `filter` (all entries when omitted). Each review counts once. */
export function scorePool(entries: readonly PoolEntry[], filter?: ReviewerFilter): PoolScore {
  let weightedSum = 0
  let totalWeight = 0
  let reviewCount = 0
  let nativeCount = 0
  let scrapedCount = 0
  let nativeSum = 0
  let scrapedSum = 0
  const reviewers = new Set<string>()

  for (const entry of entries) {
    if (filter && !filter(entry)) continue
    weightedSum += entry.weight * entry.rating
    totalWeight += entry.weight
    reviewCount += 1
    reviewers.add(entry.reviewerKey)
    if (entry.source === 'first_party') {
      nativeCount += 1
      nativeSum += entry.rating
    } else {
      scrapedCount += 1
      scrapedSum += entry.rating
    }
  }

  return {
    display_avg: totalWeight > 0 ? round(weightedSum / totalWeight, 4) : null,
    ranking_value: totalWeight > 0 ? round(rankingValue(weightedSum, totalWeight), 4) : null,
    review_count: reviewCount,
    total_weight: totalWeight,
    weighted_sum: round(weightedSum, 4),
    reviewer_count: reviewers.size,
    native_count: nativeCount,
    scraped_count: scrapedCount,
    native_avg: nativeCount > 0 ? round(nativeSum / nativeCount, 4) : null,
    scraped_avg: scrapedCount > 0 ? round(scrapedSum / scrapedCount, 4) : null,
  }
}

/** Group entries by restaurant UUID. */
export function groupPoolByRestaurant(entries: readonly PoolEntry[]): Map<string, PoolEntry[]> {
  const out = new Map<string, PoolEntry[]>()
  for (const entry of entries) {
    const list = out.get(entry.restaurantUuid) ?? []
    list.push(entry)
    out.set(entry.restaurantUuid, list)
  }
  return out
}

function round(value: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

// ---------------------------------------------------------------------------
// Reviewer filters (§5)
// ---------------------------------------------------------------------------

/** Overall: everyone, including untagged scraped reviews. */
export const everyone: ReviewerFilter = () => true

/** Reviewer has at least one of these leaf palates (Your Score trust set, Shared). */
export function reviewerHasAnyLeaf(leafIds: Iterable<number>): ReviewerFilter {
  const wanted = new Set(leafIds)
  return (entry) => [...entry.identity.leafIds].some((id) => wanted.has(id))
}

/** Reviewer's palate falls in one of these regions (Group Score). */
export function reviewerInAnyRegion(regionIds: Iterable<number>): ReviewerFilter {
  const wanted = new Set(regionIds)
  return (entry) => [...entry.identity.regionIds].some((id) => wanted.has(id))
}

/**
 * Authentic: reviewer palate matches the restaurant's cuisines. A leaf cuisine matches reviewers
 * with that palate; a region-level restaurant cuisine matches reviewers from that region.
 */
export function reviewerMatchesRestaurantCuisines(cuisines: {
  leafIds: ReadonlySet<number>
  regionIds: ReadonlySet<number>
}): ReviewerFilter {
  return (entry) =>
    [...entry.identity.leafIds].some((id) => cuisines.leafIds.has(id)) ||
    [...entry.identity.regionIds].some((id) => cuisines.regionIds.has(id))
}

/**
 * Resolve palate slugs (e.g. from a request) to leaf ids. Unknown slugs are ignored.
 * Region slugs are ignored unless `expandRegions` is set, in which case they expand to their cuisines.
 */
export function leafIdsForSlugs(
  slugs: Iterable<string>,
  taxonomy: CuisineTaxonomy,
  options?: { expandRegions?: boolean },
): Set<number> {
  const out = new Set<number>()
  for (const slug of slugs) {
    const row = taxonomy.bySlug.get(normalizeCuisineSlug(slug))
    if (!row) continue
    if (row.parent_id != null) {
      out.add(row.id)
    } else if (options?.expandRegions) {
      for (const child of taxonomy.byId.values()) {
        if (child.parent_id === row.id) out.add(child.id)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Palate rows (unweighted, per source)
// ---------------------------------------------------------------------------

export type CuisineBucket = {
  /** Raw sum of ratings (unweighted). */
  sum: number
  count: number
  reviewers: Set<string>
}

/**
 * Bucket entries by the reviewer's leaf cuisines and regions, for `restaurant_palate_rating_summary`.
 * Unweighted: callers pass one source at a time. A review counts once per leaf and once per region,
 * even when two of the reviewer's palates share a region.
 */
export function bucketEntriesByCuisine(entries: readonly PoolEntry[]): Map<number, CuisineBucket> {
  const buckets = new Map<number, CuisineBucket>()
  const add = (cuisineId: number, entry: PoolEntry) => {
    const bucket = buckets.get(cuisineId) ?? { sum: 0, count: 0, reviewers: new Set<string>() }
    bucket.sum += entry.rating
    bucket.count += 1
    bucket.reviewers.add(entry.reviewerKey)
    buckets.set(cuisineId, bucket)
  }
  for (const entry of entries) {
    for (const leafId of entry.identity.leafIds) add(leafId, entry)
    for (const regionId of entry.identity.regionIds) add(regionId, entry)
  }
  return buckets
}

// ---------------------------------------------------------------------------
// Public visibility (review lists)
// ---------------------------------------------------------------------------

/** Statuses visible to everyone in review lists. Mirrors EXCLUDED_NATIVE_STATUSES. */
export const PUBLIC_REVIEW_STATUSES: ReadonlySet<string> = new Set(['approved', 'pending'])

/** Hasura `where` fragment for public reviews (status not draft/rejected). */
export const PUBLIC_REVIEW_STATUS_WHERE = 'status: { _nin: ["draft", "rejected"] }'

export function isPublicReviewStatus(status: string | null | undefined): boolean {
  return !status || !EXCLUDED_NATIVE_STATUSES.has(status)
}

import { hasuraAdmin, hasuraQuery } from './hasura'

export const PALATE_RATING_GLOBAL_MEAN = 4.0
export const PALATE_RATING_CONFIDENCE_M = 5
export const PALATE_RATING_MIN_LEAF_REVIEWS = 3

export type PalateRatingSource = 'external' | 'first_party'

type CuisineRow = {
  id: number
  slug: string
  name: string
  parent_id: number | null
}

type Bucket = {
  sum: number
  count: number
  reviewers: Set<string>
}

const GET_ALL_CUISINES = `
  query GetAllCuisinesForPalateRatingRebuild {
    restaurant_cuisines(order_by: { id: asc }) {
      id slug name parent_id
    }
  }
`

const GET_RESTAURANT_ID = `
  query GetRestaurantIdForPalateRebuild($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) { id }
  }
`

const GET_EXTERNAL_REVIEWS = `
  query ExternalReviewsForPalateRebuild($restaurantUuid: uuid!) {
    restaurant_external_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        is_flagged: { _eq: false }
      }
    ) {
      id rating author_palates source_author_id source_author_name
    }
  }
`

const GET_FIRST_PARTY_REVIEWS = `
  query FirstPartyReviewsForPalateRebuild($restaurantUuid: uuid!) {
    restaurant_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
    ) {
      rating author_id palates
    }
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
    restaurant_external_reviews(distinct_on: restaurant_uuid) {
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
        status: { _eq: "approved" }
      }
      distinct_on: restaurant_uuid
    ) {
      restaurant_uuid
    }
  }
`

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
}

function bayesianWeighted(avg: number, count: number): number {
  return Number(
    (
      (avg * count + PALATE_RATING_GLOBAL_MEAN * PALATE_RATING_CONFIDENCE_M) /
      (count + PALATE_RATING_CONFIDENCE_M)
    ).toFixed(4),
  )
}

function extractPalateSlugs(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return normalizeSlug(item)
        if (typeof item === 'object' && item !== null) {
          const obj = item as { slug?: string; name?: string }
          return normalizeSlug(String(obj.slug ?? obj.name ?? ''))
        }
        return normalizeSlug(String(item))
      })
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    try {
      return extractPalateSlugs(JSON.parse(raw) as unknown)
    } catch {
      return raw
        .split(/[|,]/)
        .map((part) => normalizeSlug(part))
        .filter(Boolean)
    }
  }
  return []
}

function buildCuisineMaps(rows: CuisineRow[]) {
  const bySlug = new Map<string, CuisineRow>()
  const leafById = new Map<number, CuisineRow>()
  const parentById = new Map<number, CuisineRow>()

  for (const row of rows) {
    const normalized = { ...row, slug: normalizeSlug(row.slug) }
    bySlug.set(normalized.slug, normalized)
    if (normalized.parent_id == null) {
      parentById.set(normalized.id, normalized)
    } else {
      leafById.set(normalized.id, normalized)
    }
  }

  return { bySlug, leafById, parentById }
}

function addToBucket(
  buckets: Map<number, Bucket>,
  cuisineId: number,
  rating: number,
  reviewerKey: string,
) {
  const bucket = buckets.get(cuisineId) ?? { sum: 0, count: 0, reviewers: new Set<string>() }
  bucket.sum += rating
  bucket.count += 1
  if (reviewerKey) bucket.reviewers.add(reviewerKey)
  buckets.set(cuisineId, bucket)
}

function attributeReviewToBuckets(
  buckets: Map<number, Bucket>,
  leafSlugs: string[],
  rating: number,
  reviewerKey: string,
  bySlug: Map<string, CuisineRow>,
) {
  const leafIds = new Set<number>()
  const parentIds = new Set<number>()

  for (const slug of leafSlugs) {
    const leaf = bySlug.get(normalizeSlug(slug))
    if (!leaf || leaf.parent_id == null) continue
    leafIds.add(leaf.id)
    parentIds.add(leaf.parent_id)
  }

  for (const leafId of leafIds) {
    addToBucket(buckets, leafId, rating, reviewerKey)
  }
  for (const parentId of parentIds) {
    addToBucket(buckets, parentId, rating, reviewerKey)
  }
}

async function loadAuthorProfiles(authorIds: string[]): Promise<Map<string, unknown>> {
  if (authorIds.length === 0) return new Map()

  const unique = [...new Set(authorIds.map((id) => id.trim()).filter(Boolean))]
  const result = await hasuraQuery<{
    user_profiles: Array<{ id: string; palates: unknown }>
  }>(
    `query AuthorProfilesForPalateRebuild($ids: [uuid!]!) {
      user_profiles(where: { id: { _in: $ids } }) { id palates }
    }`,
    { ids: unique },
  )

  const map = new Map<string, unknown>()
  for (const profile of result.data?.user_profiles ?? []) {
    map.set(profile.id.trim().toLowerCase(), profile.palates)
  }
  return map
}

async function resolveRestaurantId(restaurantUuid: string): Promise<number | null> {
  const result = await hasuraQuery<{ restaurants: Array<{ id: number }> }>(GET_RESTAURANT_ID, {
    uuid: restaurantUuid.trim(),
  })
  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join(', '))
  }
  return result.data?.restaurants?.[0]?.id ?? null
}

export async function rebuildPalateRatingSummary(
  restaurantUuid: string,
  source: PalateRatingSource,
): Promise<{ rows_upserted: number }> {
  const uuid = restaurantUuid.trim()
  if (!uuid) return { rows_upserted: 0 }

  const [restaurantId, cuisineResult] = await Promise.all([
    resolveRestaurantId(uuid),
    hasuraQuery<{ restaurant_cuisines: CuisineRow[] }>(GET_ALL_CUISINES),
  ])

  if (!restaurantId) {
    console.warn('[rebuildPalateRatingSummary] Restaurant not found:', uuid)
    return { rows_upserted: 0 }
  }
  if (cuisineResult.errors?.length) {
    throw new Error(cuisineResult.errors.map((e) => e.message).join(', '))
  }

  const { bySlug } = buildCuisineMaps(cuisineResult.data?.restaurant_cuisines ?? [])
  const buckets = new Map<number, Bucket>()

  if (source === 'external') {
    const reviewsResult = await hasuraQuery<{
      restaurant_external_reviews: Array<{
        id: string
        rating: number
        author_palates: string[] | null
        source_author_id: string | null
        source_author_name: string | null
      }>
    }>(GET_EXTERNAL_REVIEWS, { restaurantUuid: uuid })

    if (reviewsResult.errors?.length) {
      throw new Error(reviewsResult.errors.map((e) => e.message).join(', '))
    }

    for (const review of reviewsResult.data?.restaurant_external_reviews ?? []) {
      const rating = Number(review.rating)
      if (!Number.isFinite(rating) || rating <= 0) continue

      const leafSlugs = (review.author_palates ?? []).map(normalizeSlug).filter(Boolean)
      if (leafSlugs.length === 0) continue

      const reviewerKey =
        review.source_author_id?.trim() ||
        review.source_author_name?.trim() ||
        review.id

      attributeReviewToBuckets(buckets, leafSlugs, rating, reviewerKey, bySlug)
    }
  } else {
    const reviewsResult = await hasuraQuery<{
      restaurant_reviews: Array<{
        rating: number | null
        author_id: string | null
        palates: unknown
      }>
    }>(GET_FIRST_PARTY_REVIEWS, { restaurantUuid: uuid })

    if (reviewsResult.errors?.length) {
      throw new Error(reviewsResult.errors.map((e) => e.message).join(', '))
    }

    const reviews = reviewsResult.data?.restaurant_reviews ?? []
    const authorIds = reviews
      .map((review) => review.author_id?.trim())
      .filter((id): id is string => Boolean(id))
    const authorProfiles = await loadAuthorProfiles(authorIds)

    for (const review of reviews) {
      const rating = Number(review.rating)
      if (!Number.isFinite(rating) || rating <= 0) continue

      const authorKey = review.author_id?.trim().toLowerCase() ?? ''
      const profilePalates = authorKey ? authorProfiles.get(authorKey) : null
      const profileSlugs = extractPalateSlugs(profilePalates)
      const leafSlugs =
        profileSlugs.length > 0 ? profileSlugs : extractPalateSlugs(review.palates)
      if (leafSlugs.length === 0) continue

      const reviewerKey = authorKey || leafSlugs.join('|')
      attributeReviewToBuckets(buckets, leafSlugs, rating, reviewerKey, bySlug)
    }
  }

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

    const result = await hasuraQuery<{
      restaurant_external_reviews?: Array<{ restaurant_uuid: string }>
      restaurant_reviews?: Array<{ restaurant_uuid: string | null }>
    }>(query)

    if (result.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join(', '))
    }

    const uuids = [
      ...new Set(
        reviewSource === 'external'
          ? (result.data?.restaurant_external_reviews ?? []).map((row) => row.restaurant_uuid)
          : (result.data?.restaurant_reviews ?? [])
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

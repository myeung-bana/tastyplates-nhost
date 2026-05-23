import { hasuraQuery } from './hasura'
import { getProfilesByIds, type UserProfileRow } from './user-profile'

/** Matches mobile `TrendingReviewAuthor` / GraphQL `AuthorProfile` selection. */
export type ReviewAuthorProfilePayload = {
  user_id: string
  username: string | null
  palates: unknown
  user: {
    avatarUrl: string | null
    email: string | null
    displayName: string | null
  } | null
}

/** Restaurant summary attached to list / feed review rows. */
export type ReviewRestaurantBrief = {
  uuid: string
  title: string | null
  slug: string | null
  featured_image_url?: string | null
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ReviewRowWithAuthor = {
  author_id?: string | null
  restaurant_uuid?: string | null
  AuthorProfile?: ReviewAuthorProfilePayload | null
  author?: ReviewAuthorProfilePayload | null
  restaurant?: ReviewRestaurantBrief | null
}

export type EnrichReviewsOptions = {
  /** Batch-load `restaurants` by `restaurant_uuid` and set `restaurant` on each row. */
  restaurants?: boolean
  /** Include `featured_image_url` on restaurant briefs (carousel / cards). */
  includeRestaurantImage?: boolean
}

const GET_RESTAURANTS_BY_UUIDS = `
  query GetRestaurantsByUuidsForReviewEnrichment($uuids: [uuid!]!) {
    restaurants(where: { uuid: { _in: $uuids } }) {
      uuid
      title
      slug
      featured_image_url
    }
  }
`

/** Inner fields for `restaurant_reviews.author` → `user_profiles` (Hasura metadata). */
export const REVIEW_AUTHOR_PROFILE_FIELDS = `
  user_id
  username
  palates
  user {
    avatarUrl
    email
    displayName
  }
`

/** Nested author selection — use in all review Hasura queries (not `AuthorProfile`). */
export const REVIEW_AUTHOR_GRAPHQL_NESTED = `
  author {
    ${REVIEW_AUTHOR_PROFILE_FIELDS}
  }
`

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

function emailLocalPart(email: string | null | undefined): string | null {
  const e = email?.trim()
  if (!e || !e.includes('@')) return null
  return e.split('@')[0] ?? null
}

export function profileRowToAuthorProfile(row: UserProfileRow): ReviewAuthorProfilePayload {
  return {
    user_id: row.user_id,
    username: row.username ?? null,
    palates: row.palates ?? null,
    user: {
      avatarUrl: row.user?.avatarUrl ?? null,
      email: row.user?.email ?? null,
      displayName: row.user?.displayName ?? null,
    },
  }
}

function asAuthorProfile(value: unknown): ReviewAuthorProfilePayload | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const user_id = typeof o.user_id === 'string' ? o.user_id : null
  if (!user_id) return null

  const nestedUser = o.user
  let user: ReviewAuthorProfilePayload['user'] = null
  if (nestedUser && typeof nestedUser === 'object') {
    const u = nestedUser as Record<string, unknown>
    user = {
      avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : null,
      email: typeof u.email === 'string' ? u.email : null,
      displayName: typeof u.displayName === 'string' ? u.displayName : null,
    }
  }

  return {
    user_id,
    username: typeof o.username === 'string' ? o.username : null,
    palates: o.palates ?? null,
    user,
  }
}

/** Enough for display name / avatar in clients (avoids "Someone" / "Member" fallbacks). */
export function isAuthorProfileUsable(profile: ReviewAuthorProfilePayload | null | undefined): boolean {
  if (!profile) return false
  if (profile.username?.trim()) return true
  if (profile.user?.displayName?.trim()) return true
  if (emailLocalPart(profile.user?.email)) return true
  return false
}

function mergeAuthorProfiles(
  fromGraphql: ReviewAuthorProfilePayload | null,
  fromBatch: ReviewAuthorProfilePayload | null,
): ReviewAuthorProfilePayload | null {
  if (!fromGraphql && !fromBatch) return null
  if (!fromGraphql) return fromBatch
  if (!fromBatch) return fromGraphql

  return {
    user_id: fromGraphql.user_id || fromBatch.user_id,
    username: fromGraphql.username?.trim() || fromBatch.username?.trim() || null,
    palates: fromGraphql.palates ?? fromBatch.palates ?? null,
    user: {
      avatarUrl: fromGraphql.user?.avatarUrl?.trim() || fromBatch.user?.avatarUrl?.trim() || null,
      email: fromGraphql.user?.email?.trim() || fromBatch.user?.email?.trim() || null,
      displayName:
        fromGraphql.user?.displayName?.trim() || fromBatch.user?.displayName?.trim() || null,
    },
  }
}

/**
 * Hasura metadata may expose the relationship as `author`; clients expect `AuthorProfile`.
 */
export function normalizeReviewAuthorFields(review: Record<string, unknown>): void {
  const fromAuthor = asAuthorProfile(review.author)
  const fromProfile = asAuthorProfile(review.AuthorProfile)
  const merged = mergeAuthorProfiles(fromProfile, fromAuthor)
  if (merged) {
    review.AuthorProfile = merged
  }
}

export async function buildAuthorProfileMap(
  authorIds: string[],
): Promise<Map<string, ReviewAuthorProfilePayload>> {
  const unique = [...new Set(authorIds.filter(isValidUuid))]
  if (unique.length === 0) return new Map()

  const rows = await getProfilesByIds(unique)
  const map = new Map<string, ReviewAuthorProfilePayload>()
  for (const row of rows) {
    map.set(row.user_id, profileRowToAuthorProfile(row))
  }
  return map
}

export async function fetchRestaurantBriefMap(
  uuids: string[],
): Promise<Map<string, ReviewRestaurantBrief>> {
  const unique = [...new Set(uuids.filter(isValidUuid))]
  const map = new Map<string, ReviewRestaurantBrief>()
  if (unique.length === 0) return map

  type RestaurantsResult = {
    restaurants: Array<{
      uuid: string
      title: string | null
      slug: string | null
      featured_image_url?: string | null
    }>
  }

  const restResult = await hasuraQuery<RestaurantsResult>(GET_RESTAURANTS_BY_UUIDS, { uuids: unique })
  if (restResult.errors?.length) {
    console.error('[review-enrichment] restaurant batch', restResult.errors)
    return map
  }

  for (const r of restResult.data?.restaurants ?? []) {
    map.set(r.uuid, {
      uuid: r.uuid,
      title: r.title ?? null,
      slug: r.slug ?? null,
      featured_image_url: r.featured_image_url ?? null,
    })
  }
  return map
}

/**
 * Ensures each review has a usable `AuthorProfile` (batch `user_profiles`) and optional `restaurant`.
 * Mirrors legacy web following-feed author + restaurant hydration.
 */
export async function enrichReviewRows<T extends ReviewRowWithAuthor & Record<string, unknown>>(
  reviews: T[],
  options: EnrichReviewsOptions = {},
): Promise<T[]> {
  if (reviews.length === 0) return reviews

  const rows = reviews.map((r) => {
    const copy = { ...r } as T & Record<string, unknown>
    normalizeReviewAuthorFields(copy)
    return copy
  })

  const authorIds = rows
    .map((r) => r.author_id)
    .filter((id): id is string => isValidUuid(id))

  const profileMap = await buildAuthorProfileMap(authorIds)

  for (const row of rows) {
    const authorId = row.author_id
    const fromBatch = authorId && isValidUuid(authorId) ? profileMap.get(authorId) ?? null : null
    const fromGraphql =
      asAuthorProfile(row.AuthorProfile) ?? asAuthorProfile(row.author)
    const merged = mergeAuthorProfiles(fromGraphql, fromBatch)

    if (merged) {
      row.AuthorProfile = merged
    } else if (fromGraphql) {
      row.AuthorProfile = fromGraphql
    } else if (fromBatch) {
      row.AuthorProfile = fromBatch
    }
  }

  if (!options.restaurants) {
    return rows
  }

  const uuids = rows
    .map((r) => r.restaurant_uuid)
    .filter((id): id is string => isValidUuid(id))

  const restaurantMap = await fetchRestaurantBriefMap(uuids)

  return rows.map((row) => {
    const uuid = row.restaurant_uuid
    if (!uuid || !isValidUuid(uuid)) return row

    const brief = restaurantMap.get(uuid)
    if (!brief) return row

    if (!options.includeRestaurantImage) {
      const { featured_image_url: _img, ...rest } = brief
      return { ...row, restaurant: rest }
    }

    return { ...row, restaurant: brief }
  })
}

/** Enrich a single review row (detail viewer). */
export async function enrichReviewRow<T extends ReviewRowWithAuthor>(
  review: T | null,
  options: EnrichReviewsOptions = {},
): Promise<T | null> {
  if (!review) return null
  const [enriched] = await enrichReviewRows([review], options)
  return enriched ?? null
}

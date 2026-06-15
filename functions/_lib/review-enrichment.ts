import { hasuraQuery } from './hasura'
import type { UserProfileRow } from './user-profile'

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
  /** Direct Hasura relationship `restaurant_reviews.user` → `auth.users` (optional). */
  user?: unknown
  restaurant?: ReviewRestaurantBrief | null
}

export type EnrichReviewsOptions = {
  /** Batch-load `restaurants` by `restaurant_uuid` and set `restaurant` on each row. */
  restaurants?: boolean
  /** Include `featured_image_url` on restaurant briefs (carousel / cards). */
  includeRestaurantImage?: boolean
}

/** Profile batch by `author_id` (= `user_profiles.user_id`). Avoids broken Hasura `AuthorProfile` joins. */
const GET_PROFILES_FOR_REVIEW_AUTHORS_STRING = `
  query GetProfilesForReviewAuthors($userIds: [String!]!) {
    user_profiles(where: { user_id: { _in: $userIds } }) {
      user_id
      username
      palates
      user {
        avatarUrl
        email
        displayName
      }
    }
  }
`

const GET_PROFILES_FOR_REVIEW_AUTHORS_BPCHAR = `
  query GetProfilesForReviewAuthorsBpchar($userIds: [bpchar!]!) {
    user_profiles(where: { user_id: { _in: $userIds } }) {
      user_id
      username
      palates
      user {
        avatarUrl
        email
        displayName
      }
    }
  }
`

const GET_PROFILES_FOR_REVIEW_AUTHORS_UUID = `
  query GetProfilesForReviewAuthorsUuid($userIds: [uuid!]!) {
    user_profiles(where: { user_id: { _in: $userIds } }) {
      user_id
      username
      palates
      user {
        avatarUrl
        email
        displayName
      }
    }
  }
`

/** Fallback when no `user_profiles` row — uses direct `restaurant_reviews.user` → `auth.users` if present. */
const GET_AUTH_USERS_FOR_REVIEW_AUTHORS = `
  query GetAuthUsersForReviewAuthors($ids: [uuid!]!) {
    users(where: { id: { _in: $ids } }) {
      id
      email
      displayName
      avatarUrl
    }
  }
`

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

/** Inner fields when Hasura `AuthorProfile` → `user_profiles` is configured correctly. */
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

/**
 * Nested author selection for review list queries.
 * Intentionally empty: cloud Hasura may map `AuthorProfile` to the wrong table/column.
 * Author data is hydrated in `enrichReviewRows` via batch `user_profiles` (+ auth.users fallback).
 */
export const REVIEW_AUTHOR_GRAPHQL_NESTED = ''

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

/** Normalise `user_profiles.user_id` (bpchar) and UUID keys for map lookup. */
export function normalizeAuthorIdKey(id: string): string {
  return id.trim().toLowerCase()
}

function emailLocalPart(email: string | null | undefined): string | null {
  const e = email?.trim()
  if (!e || !e.includes('@')) return null
  return e.split('@')[0] ?? null
}

export function profileRowToAuthorProfile(
  row: Pick<UserProfileRow, 'user_id' | 'username' | 'palates'> & {
    user?: UserProfileRow['user'] | null
  },
): ReviewAuthorProfilePayload {
  return {
    user_id: row.user_id.trim(),
    username: row.username ?? null,
    palates: row.palates ?? null,
    user: {
      avatarUrl: row.user?.avatarUrl ?? null,
      email: row.user?.email ?? null,
      displayName: row.user?.displayName ?? null,
    },
  }
}

function asAuthUserFields(value: unknown): ReviewAuthorProfilePayload['user'] | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Record<string, unknown>
  return {
    avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : null,
    email: typeof u.email === 'string' ? u.email : null,
    displayName: typeof u.displayName === 'string' ? u.displayName : null,
  }
}

/** Maps nested `user_profiles`, legacy `author`, or direct `restaurant_reviews.user` → `auth.users`. */
function asAuthorProfile(value: unknown, authorIdHint?: string | null): ReviewAuthorProfilePayload | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const user_id =
    typeof o.user_id === 'string'
      ? o.user_id.trim()
      : typeof o.id === 'string'
        ? o.id.trim()
        : typeof authorIdHint === 'string'
          ? authorIdHint.trim()
          : null
  if (!user_id) return null

  const nestedUser = o.user
  const userFromNested = asAuthUserFields(nestedUser)
  const userFromSelf =
    typeof o.avatarUrl === 'string' ||
    typeof o.email === 'string' ||
    typeof o.displayName === 'string'
      ? asAuthUserFields(o)
      : null

  return {
    user_id,
    username: typeof o.username === 'string' ? o.username : null,
    palates: o.palates ?? null,
    user: userFromNested ?? userFromSelf,
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
 * Normalises review author data. Hasura returns the relationship as `AuthorProfile`;
 * any legacy `author` field is also merged in as a fallback.
 */
export function normalizeReviewAuthorFields(review: Record<string, unknown>): void {
  const authorIdHint =
    typeof review.author_id === 'string' ? review.author_id : null
  const fromDirectUser = asAuthorProfile(review.user, authorIdHint)
  const fromAuthor = asAuthorProfile(review.author, authorIdHint)
  const fromProfile = asAuthorProfile(review.AuthorProfile, authorIdHint)
  let merged = mergeAuthorProfiles(fromProfile, fromAuthor)
  merged = mergeAuthorProfiles(merged, fromDirectUser)
  if (merged) {
    review.AuthorProfile = merged
  }
}

async function queryProfilesForAuthors(
  userIds: string[],
): Promise<UserProfileRow[]> {
  if (userIds.length === 0) return []

  type ProfileResult = { user_profiles: UserProfileRow[] }

  let result = await hasuraQuery<ProfileResult>(GET_PROFILES_FOR_REVIEW_AUTHORS_STRING, {
    userIds,
  })
  if (!result.errors?.length) {
    return result.data?.user_profiles ?? []
  }

  const firstError = result.errors[0]?.message ?? ''
  if (firstError.includes('bpchar')) {
    result = await hasuraQuery<ProfileResult>(GET_PROFILES_FOR_REVIEW_AUTHORS_BPCHAR, {
      userIds,
    })
    if (!result.errors?.length) {
      return result.data?.user_profiles ?? []
    }
  }

  if (firstError.includes('String') || firstError.includes('uuid')) {
    result = await hasuraQuery<ProfileResult>(GET_PROFILES_FOR_REVIEW_AUTHORS_UUID, {
      userIds,
    })
    if (!result.errors?.length) {
      return result.data?.user_profiles ?? []
    }
  }

  console.error('[review-enrichment] profile batch lookup failed', result.errors)
  return []
}

export async function buildAuthorProfileMap(
  authorIds: string[],
): Promise<Map<string, ReviewAuthorProfilePayload>> {
  const unique = [...new Set(authorIds.filter(isValidUuid))]
  if (unique.length === 0) return new Map()

  const rows = await queryProfilesForAuthors(unique)
  const map = new Map<string, ReviewAuthorProfilePayload>()
  for (const row of rows) {
    const profile = profileRowToAuthorProfile(row)
    map.set(normalizeAuthorIdKey(profile.user_id), profile)
  }
  return map
}

async function buildAuthUserProfileMap(
  authorIds: string[],
): Promise<Map<string, ReviewAuthorProfilePayload>> {
  const unique = [...new Set(authorIds.filter(isValidUuid))]
  if (unique.length === 0) return new Map()

  type AuthUserRow = {
    id: string
    email: string | null
    displayName: string | null
    avatarUrl: string | null
  }

  const result = await hasuraQuery<{ users: AuthUserRow[] }>(GET_AUTH_USERS_FOR_REVIEW_AUTHORS, {
    ids: unique,
  })
  if (result.errors?.length) {
    console.error('[review-enrichment] auth.users batch lookup failed', result.errors)
    return new Map()
  }

  const map = new Map<string, ReviewAuthorProfilePayload>()
  for (const row of result.data?.users ?? []) {
    map.set(normalizeAuthorIdKey(row.id), {
      user_id: row.id,
      username: null,
      palates: null,
      user: {
        avatarUrl: row.avatarUrl ?? null,
        email: row.email ?? null,
        displayName: row.displayName ?? null,
      },
    })
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

  const needsAuthFallback = authorIds.filter((id) => {
    const batch = profileMap.get(normalizeAuthorIdKey(id))
    return !batch || !isAuthorProfileUsable(batch)
  })
  const authMap =
    needsAuthFallback.length > 0 ? await buildAuthUserProfileMap(needsAuthFallback) : new Map()

  for (const row of rows) {
    const authorId = row.author_id
    const authorKey =
      authorId && isValidUuid(authorId) ? normalizeAuthorIdKey(authorId) : null
    const fromBatch = authorKey ? profileMap.get(authorKey) ?? null : null
    const fromAuth = authorKey ? authMap.get(authorKey) ?? null : null
    const fromGraphql =
      asAuthorProfile(row.AuthorProfile, authorId) ??
      asAuthorProfile(row.author, authorId) ??
      asAuthorProfile(row.user, authorId)

    let merged = mergeAuthorProfiles(fromGraphql, fromBatch)
    merged = mergeAuthorProfiles(merged, fromAuth)

    if (merged) {
      row.AuthorProfile = merged
    } else if (fromGraphql) {
      row.AuthorProfile = fromGraphql
    } else if (fromBatch) {
      row.AuthorProfile = fromBatch
    } else if (fromAuth) {
      row.AuthorProfile = fromAuth
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

/**
 * Best-effort enrichment — never throws; returns raw rows if batch lookups fail.
 * Use in all review HTTP handlers so Manage Reviews / feeds do not 500.
 */
export async function safeEnrichReviewRows<T extends ReviewRowWithAuthor & Record<string, unknown>>(
  reviews: T[],
  options: EnrichReviewsOptions = {},
): Promise<T[]> {
  try {
    return await enrichReviewRows(reviews, options)
  } catch (error) {
    console.error('[review-enrichment] safeEnrichReviewRows failed, returning partial rows', error)
    return reviews.map((row) => {
      const copy = { ...row } as T & Record<string, unknown>
      try {
        normalizeReviewAuthorFields(copy)
      } catch {
        /* ignore */
      }
      return copy as T
    })
  }
}

export async function safeEnrichReviewRow<T extends ReviewRowWithAuthor>(
  review: T | null,
  options: EnrichReviewsOptions = {},
): Promise<T | null> {
  if (!review) return null
  const [enriched] = await safeEnrichReviewRows([review], options)
  return enriched ?? null
}

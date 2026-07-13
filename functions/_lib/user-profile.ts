import { randomBytes } from 'node:crypto'

import { hasuraAdmin, hasuraMutation } from './hasura'
import { snapshotFromProfileRow, type UserLocationSnapshot } from './userLocationProfile'

const PROFILE_FIELDS = `
  user_id
  username
  about_me
  birthdate
  gender
  pronoun
  palates
  onboarding_complete
  created_at
  updated_at
  deleted_at
  address
  zip_code
  latitude
  longitude
  current_location_id
  current_location_slug
  current_latitude
  current_longitude
  hometown_location_id
  hometown_location_slug
  hometown_latitude
  hometown_longitude
  location_profile_updated_at
  user {
    id
    email
    displayName
    avatarUrl
    locale
    createdAt
    metadata
  }
`

export interface UserProfileRow {
  user_id: string
  username: string | null
  about_me: string | null
  birthdate: string | null
  gender: string | null
  pronoun: string | null
  palates: unknown
  onboarding_complete: boolean
  created_at: string
  updated_at: string | null
  deleted_at?: string | null
  address?: string | null
  zip_code?: string | null
  latitude?: number | null
  longitude?: number | null
  current_location_id?: number | null
  current_location_slug?: string | null
  current_latitude?: number | null
  current_longitude?: number | null
  hometown_location_id?: number | null
  hometown_location_slug?: string | null
  hometown_latitude?: number | null
  hometown_longitude?: number | null
  location_profile_updated_at?: string | null
  user: {
    id: string
    email: string
    displayName: string | null
    avatarUrl: string | null
    locale: string | null
    createdAt: string
    metadata?: { provider?: string } | null
  }
}

export interface PublicUserProfile {
  id: string
  user_id: string
  username: string | null
  display_name: string | null
  avatar_url: string | null
  about_me: string | null
  birthdate: string | null
  gender: string | null
  pronoun: string | null
  palates: unknown
  onboarding_complete: boolean
  locale: string | null
  created_at: string
  current_location: UserLocationSnapshot | null
  hometown: UserLocationSnapshot | null
}

/** Legacy shape for routes that still mirror restaurant_users field names. */
export interface LegacyRestaurantUser {
  id: string
  username: string | null
  email: string
  display_name: string | null
  profile_image: string | { url: string } | null
  about_me: string | null
  birthdate: string | null
  gender: string | null
  pronoun: string | null
  address?: string | null
  zip_code?: string | null
  latitude?: number | null
  longitude?: number | null
  current_location: UserLocationSnapshot | null
  hometown: UserLocationSnapshot | null
  palates: unknown
  language_preference: string | null
  auth_method?: string
  onboarding_complete: boolean
  created_at: string
  updated_at: string | null
}

const ACTIVE_ONLY = { deleted_at: { _is_null: true } }

function readLocationSnapshot(
  row: UserProfileRow,
  prefix: 'current' | 'hometown',
): UserLocationSnapshot | null {
  return snapshotFromProfileRow(row as unknown as Record<string, unknown>, prefix)
}

export function toPublicProfile(row: UserProfileRow): PublicUserProfile {
  return {
    id: row.user.id,
    user_id: row.user_id,
    username: row.username,
    display_name: row.user.displayName ?? row.username,
    avatar_url: row.user.avatarUrl,
    about_me: row.about_me,
    birthdate: row.birthdate,
    gender: row.gender,
    pronoun: row.pronoun,
    palates: row.palates,
    onboarding_complete: row.onboarding_complete,
    locale: row.user.locale,
    created_at: row.created_at,
    current_location: readLocationSnapshot(row, 'current'),
    hometown: readLocationSnapshot(row, 'hometown'),
  }
}

export function toLegacyUser(row: UserProfileRow): LegacyRestaurantUser {
  const avatarUrl = row.user.avatarUrl
  const currentLocation = readLocationSnapshot(row, 'current')
  const hometown = readLocationSnapshot(row, 'hometown')
  return {
    id: row.user.id,
    username: row.username,
    email: row.user.email,
    display_name: row.user.displayName ?? row.username,
    profile_image: avatarUrl ? { url: avatarUrl } : null,
    about_me: row.about_me,
    birthdate: row.birthdate,
    gender: row.gender,
    pronoun: row.pronoun,
    address: row.address ?? null,
    zip_code: row.zip_code ?? null,
    latitude: currentLocation?.latitude ?? row.latitude ?? null,
    longitude: currentLocation?.longitude ?? row.longitude ?? null,
    current_location: currentLocation,
    hometown,
    palates: row.palates,
    language_preference: row.user.locale,
    auth_method: row.user.metadata?.provider ?? 'password',
    onboarding_complete: row.onboarding_complete,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function toFollowListUser(row: UserProfileRow): {
  id: string
  username: string | null
  display_name: string | null
  profile_image: string | null
  about_me: string | null
  palates: unknown
} {
  return {
    id: row.user.id,
    username: row.username,
    display_name: row.user.displayName ?? row.username,
    profile_image: row.user.avatarUrl,
    about_me: row.about_me,
    palates: row.palates,
  }
}

export async function getProfileById(userId: string): Promise<UserProfileRow | null> {
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query GetUserProfileById($userId: bpchar!) {
        user_profiles(where: { user_id: { _eq: $userId } }, limit: 1) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { userId },
  )
  return data.user_profiles[0] ?? null
}

export async function getProfileByUsername(username: string): Promise<UserProfileRow | null> {
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query GetUserProfileByUsername($username: String!) {
        user_profiles(
          where: { username: { _eq: $username }, deleted_at: { _is_null: true } }
          limit: 1
        ) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { username },
  )
  return data.user_profiles[0] ?? null
}

export async function getProfilesByIds(userIds: string[]): Promise<UserProfileRow[]> {
  if (userIds.length === 0) return []
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query GetUserProfilesByIds($userIds: [bpchar!]!) {
        user_profiles(where: { user_id: { _in: $userIds } }) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { userIds },
  )
  return data.user_profiles
}

export async function listProfiles(opts: {
  limit: number
  offset: number
  where?: Record<string, unknown>
}): Promise<{ profiles: UserProfileRow[]; total: number }> {
  const where = {
    _and: [ACTIVE_ONLY, ...(opts.where ? [opts.where] : [])],
  }
  const data = await hasuraAdmin<{
    user_profiles: UserProfileRow[]
    user_profiles_aggregate: { aggregate: { count: number } }
  }>(
    `
      query ListUserProfiles($limit: Int!, $offset: Int!, $where: user_profiles_bool_exp!) {
        user_profiles(limit: $limit, offset: $offset, where: $where, order_by: { created_at: desc }) {
          ${PROFILE_FIELDS}
        }
        user_profiles_aggregate(where: $where) {
          aggregate { count }
        }
      }
    `,
    { limit: opts.limit, offset: opts.offset, where },
  )
  return {
    profiles: data.user_profiles,
    total: data.user_profiles_aggregate.aggregate.count,
  }
}

export async function listSuggestedProfiles(opts: {
  limit: number
  excludeUserId?: string
}): Promise<UserProfileRow[]> {
  const where: Record<string, unknown> = { _and: [ACTIVE_ONLY] }
  if (opts.excludeUserId) {
    ;(where._and as Record<string, unknown>[]).push({ user_id: { _neq: opts.excludeUserId } })
  }
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query SuggestedUserProfiles($limit: Int!, $where: user_profiles_bool_exp!) {
        user_profiles(limit: $limit, where: $where, order_by: { created_at: desc }) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { limit: opts.limit, where },
  )
  return data.user_profiles
}

export async function isUsernameTaken(username: string): Promise<boolean> {
  const data = await hasuraAdmin<{ user_profiles: Array<{ user_id: string }> }>(
    `
      query CheckUsername($username: String!) {
        user_profiles(where: { username: { _eq: $username } }, limit: 1) {
          user_id
        }
      }
    `,
    { username },
  )
  return (data.user_profiles?.length ?? 0) > 0
}

/** `user_` + 10 hex chars — fits mobile username max length (20). */
export function generatePlaceholderUsername(): string {
  return `user_${randomBytes(5).toString('hex')}`
}

export async function generateUniquePlaceholderUsername(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const username = generatePlaceholderUsername()
    if (!(await isUsernameTaken(username))) return username
  }
  return `user_${Date.now().toString(36).slice(-10)}`
}

export type EnsureUserProfileResult = {
  profile: UserProfileRow
  created: boolean
}

/**
 * Idempotent: returns existing `user_profiles` row or creates one with `user_<random>`.
 * `user_id` must be the Nhost auth UUID (`auth.users.id`).
 */
export async function ensureUserProfile(userId: string): Promise<EnsureUserProfileResult> {
  const existing = await getProfileById(userId)
  if (existing) {
    return { profile: existing, created: false }
  }

  const username = await generateUniquePlaceholderUsername()
  await createUserProfile({
    user_id: userId,
    username,
    onboarding_complete: false,
  })

  const profile = await getProfileById(userId)
  if (!profile) {
    throw new Error('ensureUserProfile: insert succeeded but profile could not be loaded')
  }

  return { profile, created: true }
}

export async function createUserProfile(object: {
  user_id: string
  username: string
  about_me?: string | null
  birthdate?: string | null
  gender?: string | null
  pronoun?: string | null
  palates?: unknown
  onboarding_complete?: boolean
}): Promise<{ user_id: string }> {
  const data = await hasuraMutation<{ insert_user_profiles_one: { user_id: string } }>(
    `
      mutation CreateUserProfile($object: user_profiles_insert_input!) {
        insert_user_profiles_one(object: $object) {
          user_id
        }
      }
    `,
    { object },
  )
  if (!data.insert_user_profiles_one) {
    throw new Error('createUserProfile: insert returned null')
  }
  return data.insert_user_profiles_one
}

export async function updateUserProfile(
  userId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await hasuraMutation<{
    update_user_profiles: { affected_rows: number }
  }>(
    `
      mutation UpdateUserProfile($userId: bpchar!, $changes: user_profiles_set_input!) {
        update_user_profiles(where: { user_id: { _eq: $userId } }, _set: $changes) {
          affected_rows
        }
      }
    `,
    { userId, changes },
  )
}

export async function softDeleteUserProfile(userId: string): Promise<void> {
  await hasuraMutation<{
    update_user_profiles: { affected_rows: number }
  }>(
    `
      mutation SoftDeleteUserProfile($userId: bpchar!, $now: timestamptz!) {
        update_user_profiles(
          where: { user_id: { _eq: $userId } }
          _set: { deleted_at: $now }
        ) {
          affected_rows
        }
      }
    `,
    { userId, now: new Date().toISOString() },
  )
}

export async function updateUserAvatar(userId: string, avatarUrl: string): Promise<void> {
  await hasuraMutation<{ updateUser: { id: string } | null }>(
    `
      mutation UpdateUserAvatar($userId: uuid!, $avatarUrl: String) {
        updateUser(pk_columns: { id: $userId }, _set: { avatarUrl: $avatarUrl }) {
          id
        }
      }
    `,
    { userId, avatarUrl },
  )
}

export async function updateUserLocale(userId: string, locale: string): Promise<void> {
  await hasuraMutation<{ updateUser: { id: string } | null }>(
    `
      mutation UpdateUserLocale($userId: uuid!, $locale: String) {
        updateUser(pk_columns: { id: $userId }, _set: { locale: $locale }) {
          id
        }
      }
    `,
    { userId, locale },
  )
}

export async function updateUserDisplayName(userId: string, displayName: string): Promise<void> {
  await hasuraMutation<{ updateUser: { id: string } | null }>(
    `
      mutation UpdateUserDisplayName($userId: uuid!, $displayName: String) {
        updateUser(pk_columns: { id: $userId }, _set: { displayName: $displayName }) {
          id
        }
      }
    `,
    { userId, displayName },
  )
}

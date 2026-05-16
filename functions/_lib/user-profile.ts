import { hasuraAdmin, hasuraMutation } from './hasura'

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
  palates: unknown
  language_preference: string | null
  auth_method?: string
  onboarding_complete: boolean
  created_at: string
  updated_at: string | null
}

const ACTIVE_ONLY = { deleted_at: { _is_null: true } }

function assertData<T>(
  result: { data: T | null; errors?: Array<{ message: string }> },
  context: string,
): T {
  if (result.errors?.length) {
    throw new Error(`${context}: ${result.errors[0]?.message ?? 'GraphQL error'}`)
  }
  if (!result.data) {
    throw new Error(`${context}: empty response`)
  }
  return result.data
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
  }
}

export function toLegacyUser(row: UserProfileRow): LegacyRestaurantUser {
  const avatarUrl = row.user.avatarUrl
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
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
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
} {
  return {
    id: row.user.id,
    username: row.username,
    display_name: row.user.displayName ?? row.username,
    profile_image: row.user.avatarUrl,
    about_me: row.about_me,
  }
}

export async function getProfileById(userId: string): Promise<UserProfileRow | null> {
  const result = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query GetUserProfileById($userId: uuid!) {
        user_profiles(where: { user_id: { _eq: $userId } }, limit: 1) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { userId },
  )
  const data = assertData(result, 'getProfileById')
  return data.user_profiles[0] ?? null
}

export async function getProfileByUsername(username: string): Promise<UserProfileRow | null> {
  const result = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
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
  const data = assertData(result, 'getProfileByUsername')
  return data.user_profiles[0] ?? null
}

export async function getProfilesByIds(userIds: string[]): Promise<UserProfileRow[]> {
  if (userIds.length === 0) return []
  const result = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query GetUserProfilesByIds($userIds: [uuid!]!) {
        user_profiles(where: { user_id: { _in: $userIds } }) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { userIds },
  )
  const data = assertData(result, 'getProfilesByIds')
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
  const result = await hasuraAdmin<{
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
  const data = assertData(result, 'listProfiles')
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
  const result = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>(
    `
      query SuggestedUserProfiles($limit: Int!, $where: user_profiles_bool_exp!) {
        user_profiles(limit: $limit, where: $where, order_by: { created_at: desc }) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    { limit: opts.limit, where },
  )
  const data = assertData(result, 'listSuggestedProfiles')
  return data.user_profiles
}

export async function isUsernameTaken(username: string): Promise<boolean> {
  const result = await hasuraAdmin<{ user_profiles: Array<{ user_id: string }> }>(
    `
      query CheckUsername($username: String!) {
        user_profiles(where: { username: { _eq: $username } }, limit: 1) {
          user_id
        }
      }
    `,
    { username },
  )
  const data = assertData(result, 'isUsernameTaken')
  return (data.user_profiles?.length ?? 0) > 0
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
  const result = await hasuraMutation<{ insert_user_profiles_one: { user_id: string } }>(
    `
      mutation CreateUserProfile($object: user_profiles_insert_input!) {
        insert_user_profiles_one(object: $object) {
          user_id
        }
      }
    `,
    { object },
  )
  const data = assertData(result, 'createUserProfile')
  if (!data.insert_user_profiles_one) {
    throw new Error('createUserProfile: insert returned null')
  }
  return data.insert_user_profiles_one
}

export async function updateUserProfile(
  userId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const result = await hasuraMutation<{
    update_user_profiles: { affected_rows: number }
  }>(
    `
      mutation UpdateUserProfile($userId: uuid!, $changes: user_profiles_set_input!) {
        update_user_profiles(where: { user_id: { _eq: $userId } }, _set: $changes) {
          affected_rows
        }
      }
    `,
    { userId, changes },
  )
  assertData(result, 'updateUserProfile')
}

export async function softDeleteUserProfile(userId: string): Promise<void> {
  const result = await hasuraMutation<{
    update_user_profiles: { affected_rows: number }
  }>(
    `
      mutation SoftDeleteUserProfile($userId: uuid!, $now: timestamptz!) {
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
  assertData(result, 'softDeleteUserProfile')
}

export async function updateUserAvatar(userId: string, avatarUrl: string): Promise<void> {
  const result = await hasuraMutation<{ updateUser: { id: string } | null }>(
    `
      mutation UpdateUserAvatar($userId: uuid!, $avatarUrl: String) {
        updateUser(pk_columns: { id: $userId }, _set: { avatarUrl: $avatarUrl }) {
          id
        }
      }
    `,
    { userId, avatarUrl },
  )
  assertData(result, 'updateUserAvatar')
}

export async function updateUserLocale(userId: string, locale: string): Promise<void> {
  const result = await hasuraMutation<{ updateUser: { id: string } | null }>(
    `
      mutation UpdateUserLocale($userId: uuid!, $locale: String) {
        updateUser(pk_columns: { id: $userId }, _set: { locale: $locale }) {
          id
        }
      }
    `,
    { userId, locale },
  )
  assertData(result, 'updateUserLocale')
}

export async function updateUserDisplayName(userId: string, displayName: string): Promise<void> {
  const result = await hasuraMutation<{ updateUser: { id: string } | null }>(
    `
      mutation UpdateUserDisplayName($userId: uuid!, $displayName: String) {
        updateUser(pk_columns: { id: $userId }, _set: { displayName: $displayName }) {
          id
        }
      }
    `,
    { userId, displayName },
  )
  assertData(result, 'updateUserDisplayName')
}

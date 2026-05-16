# Finalized Deprecation Plan — `restaurant_users` → `auth.users` + `user_profiles`

**Scope:** `tastyplates-nhost/functions/` and the legacy `tastyplates-v2-1/src/app/api/v1/` routes.

**Goal:** Drop `public.restaurant_users` with zero client-facing contract breakage, every
Nhost Function reading identity from `auth.users` / `user_profiles` only.

**Prerequisite docs:** `api-guide.md` · `deprecation-migration.md` ·
`nhost-auth-env-fixes.md` · `nhost-functions-boilerplate.md`

---

## 0. Guiding rules

These apply to every file touched in this plan:

1. **Never read `restaurant_users` in new or refactored Functions.** Identity comes
   from `auth.users`; profile data from `user_profiles`.
2. **Never trust caller-supplied `user_id`.** Always derive it from the verified JWT
   claim `x-hasura-user-id` via `requireAuth` + `getUserId`.
3. **Use `NHOST_ADMIN_SECRET` / `NHOST_GRAPHQL_URL` — never the legacy monolith
   names.** All env access goes through `_lib/env.ts`.
4. **All responses use the existing `{ ok, data }` / `{ ok, error }` envelope**
   from `_lib/respond.ts`. No raw `res.json()` outside `ok()` and `fail()`.
5. **Validation stays simple.** Use plain `if` checks on `req.query` and `req.body`
   for required fields. `_lib/validate.ts` is available for complex body shapes
   but is not required for every handler.
6. **Deprecated endpoints return `410 Gone`.** Never `404`, never a redirect.
7. **Admin operations use `hasuraAdmin()`; user-scoped operations use
   `hasuraAsUser()`.** Never mix them.
8. **`firebase_uuid` is removed from all new function contracts.**

---

## 1. `_lib/` additions before any phase

Land these two files under `functions/_lib/` first. Every phase depends on them.

### 1.1 `_lib/user-profile.ts` — new file

One place for all `user_profiles` + `auth.users` queries. No handler needs an
inline GraphQL string for user lookups.

```typescript
import { hasuraAdmin } from './hasura'

// ── Shared fragment ───────────────────────────────────────────────────────────

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
  user {
    id
    email
    displayName
    avatarUrl
    locale
    createdAt
  }
`

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserProfileRow {
  user_id: string
  username: string | null
  about_me: string | null
  birthdate: string | null
  gender: string | null
  pronoun: string | null
  palates: string[] | null
  onboarding_complete: boolean
  created_at: string
  updated_at: string
  user: {
    id: string
    email: string
    displayName: string | null
    avatarUrl: string | null
    locale: string | null
    createdAt: string
  }
}

// Public shape returned to clients.
// `id` equals `user_id` (= auth.users.id) — kept for backward compat.
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
  palates: string[] | null
  onboarding_complete: boolean
  locale: string | null
  created_at: string
}

export function toPublicProfile(row: UserProfileRow): PublicUserProfile {
  return {
    id:                  row.user.id,
    user_id:             row.user_id,
    username:            row.username,
    display_name:        row.user.displayName,
    avatar_url:          row.user.avatarUrl,
    about_me:            row.about_me,
    birthdate:           row.birthdate,
    gender:              row.gender,
    pronoun:             row.pronoun,
    palates:             row.palates,
    onboarding_complete: row.onboarding_complete,
    locale:              row.user.locale,
    created_at:          row.created_at,
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getProfileById(userId: string): Promise<UserProfileRow | null> {
  const data = await hasuraAdmin<{ user_profiles_by_pk: UserProfileRow | null }>({
    query: `
      query GetProfileById($userId: uuid!) {
        user_profiles_by_pk(user_id: $userId) { ${PROFILE_FIELDS} }
      }
    `,
    variables: { userId },
  })
  return data.user_profiles_by_pk
}

export async function getProfileByUsername(username: string): Promise<UserProfileRow | null> {
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>({
    query: `
      query GetProfileByUsername($username: String!) {
        user_profiles(where: { username: { _eq: $username } }, limit: 1) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    variables: { username },
  })
  return data.user_profiles[0] ?? null
}

export async function getProfilesByIds(userIds: string[]): Promise<UserProfileRow[]> {
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>({
    query: `
      query GetProfilesByIds($userIds: [uuid!]!) {
        user_profiles(where: { user_id: { _in: $userIds } }) {
          ${PROFILE_FIELDS}
        }
      }
    `,
    variables: { userIds },
  })
  return data.user_profiles
}

export async function listProfiles(opts: {
  limit: number
  offset: number
  where?: Record<string, unknown>
}): Promise<UserProfileRow[]> {
  const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>({
    query: `
      query ListProfiles($limit: Int!, $offset: Int!, $where: user_profiles_bool_exp) {
        user_profiles(
          limit: $limit
          offset: $offset
          where: $where
          order_by: { created_at: desc }
        ) { ${PROFILE_FIELDS} }
      }
    `,
    variables: { limit: opts.limit, offset: opts.offset, where: opts.where ?? {} },
  })
  return data.user_profiles
}
```

### 1.2 `_lib/auth-guard.ts` — new file

Three helpers that cover every auth pattern in the API guide. Handlers call one
of these at the top and then just `if (!auth) return`.

```typescript
import type { Request, Response } from 'express'
import { requireAuth, getUserId, type NhostJwtPayload } from './auth'
import { fail } from './respond'

export interface AuthContext {
  payload: NhostJwtPayload
  userId: string
}

// Required auth — sends 401 if no valid Bearer token.
export async function resolveAuth(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  const payload = await requireAuth(req, res)
  if (!payload) return null
  return { payload, userId: getUserId(payload) }
}

// Owner auth — sends 403 if the JWT user does not match expectedUserId.
// Use on any route where a user can only act on their own data.
export async function resolveOwnerAuth(
  req: Request,
  res: Response,
  expectedUserId: string,
): Promise<AuthContext | null> {
  const auth = await resolveAuth(req, res)
  if (!auth) return null
  if (auth.userId !== expectedUserId) {
    fail(res, 'Forbidden: you can only access your own resources', 403)
    return null
  }
  return auth
}

// Optional auth — returns AuthContext if a valid Bearer token is present,
// null otherwise. Never sends an error response.
// Use on public routes that personalise when logged in (e.g. suggested users).
export async function resolveOptionalAuth(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  if (!req.headers.authorization?.startsWith('Bearer ')) return null
  const payload = await requireAuth(req, res)
  if (!payload) return null
  return { payload, userId: getUserId(payload) }
}
```

---

## 2. Phase A — Read route migrations

**Branch:** `feat/deprecate-restaurant-users-phase-a`

Validation in these handlers is plain `if` checks — field presence, type coercion
with `Number()`, UUID format where needed. No schema library required for simple
query params.

### A-1 `restaurant-users/get-restaurant-users.ts`

```typescript
import type { Request, Response } from 'express'
import { listProfiles, toPublicProfile } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const limit  = Math.min(Number(req.query.limit)  || 20, 100)
    const offset = Math.max(Number(req.query.offset) || 0,  0)
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined

    const where = search
      ? {
          _or: [
            { username: { _ilike: `%${search}%` } },
            { user: { displayName: { _ilike: `%${search}%` } } },
          ],
        }
      : undefined

    const rows = await listProfiles({ limit, offset, where })
    ok(res, rows.map(toPublicProfile))
  } catch (error) {
    console.error(`[get-restaurant-users] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

---

### A-2 `restaurant-users/get-restaurant-user-by-id.ts`

Already partially aligned per `deprecation-migration.md`. Confirm it uses
`getProfileById` and `toPublicProfile` — if it still has an inline query, replace it.

```typescript
import type { Request, Response } from 'express'
import { getProfileById, toPublicProfile } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.query.id as string | undefined
    if (!id) return fail(res, 'Missing required query param: id', 400)

    const profile = await getProfileById(id)
    if (!profile) return fail(res, 'User not found', 404)

    ok(res, toPublicProfile(profile))
  } catch (error) {
    console.error(`[get-restaurant-user-by-id] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

---

### A-3 `restaurant-users/get-restaurant-user-by-username.ts`

Same pattern as A-2, using `getProfileByUsername`. Already partially aligned —
confirm the underlying query source.

```typescript
import type { Request, Response } from 'express'
import { getProfileByUsername, toPublicProfile } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const username = req.query.username as string | undefined
    if (!username) return fail(res, 'Missing required query param: username', 400)

    const profile = await getProfileByUsername(username)
    if (!profile) return fail(res, 'User not found', 404)

    ok(res, toPublicProfile(profile))
  } catch (error) {
    console.error(`[get-restaurant-user-by-username] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

---

### A-4 `restaurant-users/suggested.ts`

Uses `resolveOptionalAuth` — the current user is excluded from suggestions when a
valid Bearer is present. No auth required.

```typescript
import type { Request, Response } from 'express'
import { hasuraAdmin } from '../_lib/hasura'
import { toPublicProfile, type UserProfileRow } from '../_lib/user-profile'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const auth  = await resolveOptionalAuth(req, res)

    const where = auth ? { user_id: { _neq: auth.userId } } : {}

    const data = await hasuraAdmin<{ user_profiles: UserProfileRow[] }>({
      query: `
        query SuggestedUsers($limit: Int!, $where: user_profiles_bool_exp) {
          user_profiles(limit: $limit, where: $where, order_by: { created_at: desc }) {
            user_id username about_me onboarding_complete created_at updated_at
            user { id email displayName avatarUrl locale createdAt }
          }
        }
      `,
      variables: { limit, where },
    })

    ok(res, data.user_profiles.map(toPublicProfile))
  } catch (error) {
    console.error(`[suggested] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

---

### A-5 `restaurant-users/get-followers-list.ts` and `get-following-list.ts`

Two-step: get IDs from the follows edge, then hydrate from `user_profiles`.
No `restaurant_users` involved.

```typescript
// get-followers-list.ts
import type { Request, Response } from 'express'
import { getProfilesByIds, toPublicProfile } from '../_lib/user-profile'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.query.user_id as string | undefined
    if (!userId) return fail(res, 'Missing required query param: user_id', 400)

    const edgeData = await hasuraAdmin<{
      restaurant_user_follows: { follower_id: string }[]
    }>({
      query: `
        query GetFollowerIds($userId: uuid!) {
          restaurant_user_follows(where: { user_id: { _eq: $userId } }) {
            follower_id
          }
        }
      `,
      variables: { userId },
    })

    const followerIds = edgeData.restaurant_user_follows.map((r) => r.follower_id)
    if (!followerIds.length) return ok(res, [])

    const profiles = await getProfilesByIds(followerIds)
    ok(res, profiles.map(toPublicProfile))
  } catch (error) {
    console.error(`[get-followers-list] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

Apply the same pattern to `get-following-list.ts` — swap the follow direction
(query `follower_id = $userId`, collect `user_id` instead of `follower_id`).

---

### A-6 `restaurant-reviews/get-following-feed.ts`

Author enrichment moves to the nested Hasura relationship (`author → user_profiles`).
No separate user hydration call needed. Requires Phase E-3 relationship to be
deployed before this handler goes live.

```typescript
// Author shape comes from the nested relationship — no restaurant_users reference
const data = await hasuraAdmin<{ restaurant_reviews: ReviewRow[] }>({
  query: `
    query FollowingFeed($userId: uuid!, $limit: Int!, $cursor: timestamptz) {
      restaurant_reviews(
        where: {
          author: { user: { followers: { follower_id: { _eq: $userId } } } }
          created_at: { _lt: $cursor }
          status: { _eq: "approved" }
        }
        order_by: { created_at: desc }
        limit: $limit
      ) {
        id body rating created_at status
        author {
          user_id username
          user { id displayName avatarUrl }
        }
        restaurant { id name slug }
      }
    }
  `,
  variables: { userId: auth.userId, limit, cursor },
})
```

---

### A-7 `restaurant-reviews/get-draft-reviews.ts`

`userId` comes only from the JWT — no user lookup needed.

```typescript
import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { hasuraAdmin } from '../_lib/hasura'
import { ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const data = await hasuraAdmin<{ restaurant_reviews: unknown[] }>({
      query: `
        query DraftReviews($userId: uuid!) {
          restaurant_reviews(
            where: { author_id: { _eq: $userId }, status: { _eq: "draft" } }
            order_by: { updated_at: desc }
          ) {
            id body rating status created_at updated_at
            restaurant { id name slug }
          }
        }
      `,
      variables: { userId: auth.userId },
    })

    ok(res, data.restaurant_reviews)
  } catch (error) {
    console.error(`[get-draft-reviews] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

---

## 3. Phase B — Write route migrations

**Branch:** `feat/deprecate-restaurant-users-phase-b`

### B-1 `restaurant-users/create-restaurant-user.ts`

**Current risk:** Listed as public (no Bearer) in `api-guide.md` §8.6. Any actor
can create profile rows directly.

**Changes:**
- Require Bearer — `user_id` always comes from the JWT, never the request body
- Insert into `user_profiles` only, not `restaurant_users`
- Guard against duplicate profiles with a 409

```typescript
import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const { username, about_me, birthdate, gender, pronoun, palates } = req.body as {
      username?:  string
      about_me?:  string
      birthdate?: string
      gender?:    string
      pronoun?:   string
      palates?:   string[]
    }

    if (!username || typeof username !== 'string') {
      return fail(res, 'username is required', 400)
    }

    // Prevent duplicate profiles
    const existing = await hasuraAdmin<{
      user_profiles_by_pk: { user_id: string } | null
    }>({
      query: `
        query CheckProfile($userId: uuid!) {
          user_profiles_by_pk(user_id: $userId) { user_id }
        }
      `,
      variables: { userId: auth.userId },
    })

    if (existing.user_profiles_by_pk) {
      return fail(res, 'Profile already exists for this user', 409)
    }

    const data = await hasuraAdmin<{
      insert_user_profiles_one: { user_id: string }
    }>({
      query: `
        mutation CreateProfile($object: user_profiles_insert_input!) {
          insert_user_profiles_one(object: $object) { user_id }
        }
      `,
      variables: {
        object: {
          user_id:             auth.userId,   // always from JWT
          username,
          about_me:            about_me  ?? null,
          birthdate:           birthdate ?? null,
          gender:              gender    ?? null,
          pronoun:             pronoun   ?? null,
          palates:             palates   ?? null,
          onboarding_complete: false,
        },
      },
    })

    ok(res, { user_id: data.insert_user_profiles_one.user_id }, 201)
  } catch (error) {
    console.error(`[create-restaurant-user] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

**`api-guide.md` update required:** Change Auth column for this route from `None`
to `Bearer`.

---

### B-2 `restaurant-users/update-restaurant-user.ts`

Already partially aligned. Confirm it:

- Derives `user_id` exclusively from `auth.userId` — never `req.body.user_id`
- Runs profile fields update (`user_profiles`) and auth fields update
  (`auth.users` via Hasura) in `Promise.all` when both are present
- Maps fields correctly:
  - `display_name` → `auth.users.displayName`
  - `avatar_url` → `auth.users.avatarUrl`
  - `locale` → `auth.users.locale`
  - Everything else → `user_profiles`

No structural changes required if the above is already true. Just confirm
`restaurant_users` does not appear anywhere in the file.

---

### B-3 `restaurant-users/delete-restaurant-user.ts`

Soft delete sets `deleted_at` on `user_profiles` (requires Phase E-1 schema gap
to be in place). Hard delete calls the Nhost Auth admin API.

```typescript
import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { hasuraAdmin } from '../_lib/hasura'
import { NHOST_AUTH_URL, NHOST_ADMIN_SECRET } from '../_lib/env'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const hard = req.query.hard === 'true'

    if (hard) {
      // Remove the auth.users record — cascades to user_profiles via FK (Phase E-2)
      const deleteRes = await fetch(`${NHOST_AUTH_URL}/v1/user`, {
        method: 'DELETE',
        headers: {
          'x-hasura-admin-secret': NHOST_ADMIN_SECRET,
          'x-auth-user-id':        auth.userId,
        },
      })
      if (!deleteRes.ok) return fail(res, 'Failed to delete account', 500)
    } else {
      // Soft delete — requires deleted_at column (Phase E-1)
      await hasuraAdmin({
        query: `
          mutation SoftDeleteProfile($userId: uuid!, $now: timestamptz!) {
            update_user_profiles_by_pk(
              pk_columns: { user_id: $userId }
              _set: { deleted_at: $now }
            ) { user_id }
          }
        `,
        variables: { userId: auth.userId, now: new Date().toISOString() },
      })
    }

    ok(res, { deleted: true, hard })
  } catch (error) {
    console.error(`[delete-restaurant-user] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

---

## 4. Phase C — Deprecated stub hardening

**Branch:** `feat/deprecate-restaurant-users-phase-c`

### C-1 `restaurant-users/get-restaurant-user-by-firebase-uuid.ts`

```typescript
import type { Request, Response } from 'express'
import { fail } from '../_lib/respond'

export default (_req: Request, res: Response): void => {
  fail(
    res,
    'Removed. Use get-restaurant-user-by-id or get-restaurant-user-by-username instead.',
    410,
  )
}
```

### C-2 `tastyplates-v2-1` — remaining `insert_restaurant_users_one` callers

Replace any remaining `CREATE_RESTAURANT_USER` / `insert_restaurant_users_one`
mutations in the legacy Next.js API layer with calls to `insert_user_profiles_one`.
If the flow has fully moved to Functions, return `410` from those legacy routes.

---

## 5. Phase D — Auth and client cleanup

**Branch:** `feat/deprecate-restaurant-users-phase-d`

### D-1 `users/me.ts` — new handler replacing Firebase path

```typescript
import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { getProfileById, toPublicProfile } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const profile = await getProfileById(auth.userId)
    if (!profile) return fail(res, 'Profile not found', 404)

    ok(res, toPublicProfile(profile))
  } catch (error) {
    console.error(`[users/me] invocationId=${req.invocationId}`, error)
    fail(res, 'Internal server error', 500)
  }
}
```

Add to `api-guide.md` §8.6: `users/me | GET | Bearer | Current user profile from JWT`

### D-2 `firebase_uuid` removal

Remove `firebase_uuid` from all response types and service interfaces. Clients
reading this field will find it absent — they must be updated to use `id`
(= `auth.users.id`).

| File | Change |
|---|---|
| `src/hooks/useUserData.ts` | Replace `restaurant_users` subscription with `user_profiles` + nested `user` |
| `src/hooks/useFirebaseSession.ts` | Migrate callers to `useNhostSession`, then delete this hook |
| `src/hooks/useProfileData.ts` | Replace `firebase_uuid` guards with `user_id` |
| `src/services/auth/nhostAuthService.ts` | Remove `firebase_uuid` from `UserProfileData` type |
| `src/services/restaurantUserService.ts` | Remove dual-schema comments; `id` = auth UUID only |
| `components/review/*`, `RestaurantCard.tsx` | Author shape: `author.user.id`, `author.user.displayName`, `author.avatarUrl` |

---

## 6. Phase E — Database and Hasura

**Branch:** `feat/deprecate-restaurant-users-phase-e`

This is the only phase with destructive DB changes. Do not start until phases
A–D are fully deployed and verified in production.

### E-1 Schema gaps migration

`nhost/migrations/default/<timestamp>_user_profiles_gaps/up.sql`

```sql
-- Soft delete support (required by B-3)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_active
  ON public.user_profiles (deleted_at)
  WHERE deleted_at IS NULL;

-- Geo columns (add or skip if this feature is being dropped)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS address   text         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS zip_code  text         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS latitude  numeric(9,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS longitude numeric(9,6) DEFAULT NULL;

-- pronoun (if not already in production schema)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS pronoun text DEFAULT NULL;
```

### E-2 FK migration — switch to `auth.users(id)`

`nhost/migrations/default/<timestamp>_fk_to_auth_users/up.sql`

**Before running:** audit every FK column. Only proceed if every query returns 0 rows.

```sql
SELECT author_id          FROM restaurant_reviews         WHERE author_id          NOT IN (SELECT id FROM auth.users);
SELECT user_id            FROM restaurant_review_likes    WHERE user_id            NOT IN (SELECT id FROM auth.users);
SELECT mentioned_user_id  FROM restaurant_review_mentions WHERE mentioned_user_id  NOT IN (SELECT id FROM auth.users);
SELECT follower_id        FROM restaurant_user_follows    WHERE follower_id        NOT IN (SELECT id FROM auth.users);
SELECT user_id            FROM restaurant_user_follows    WHERE user_id            NOT IN (SELECT id FROM auth.users);
SELECT user_id            FROM user_favorites             WHERE user_id            NOT IN (SELECT id FROM auth.users);
SELECT user_id            FROM user_checkins              WHERE user_id            NOT IN (SELECT id FROM auth.users);
```

Once all return 0:

```sql
ALTER TABLE public.restaurant_reviews
  DROP CONSTRAINT IF EXISTS restaurant_reviews_author_id_fkey,
  ADD CONSTRAINT restaurant_reviews_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.restaurant_review_likes
  DROP CONSTRAINT IF EXISTS restaurant_review_likes_user_id_fkey,
  ADD CONSTRAINT restaurant_review_likes_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.restaurant_review_mentions
  DROP CONSTRAINT IF EXISTS restaurant_review_mentions_mentioned_user_id_fkey,
  ADD CONSTRAINT restaurant_review_mentions_mentioned_user_id_fkey
    FOREIGN KEY (mentioned_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.restaurant_user_follows
  DROP CONSTRAINT IF EXISTS restaurant_user_follows_follower_id_fkey,
  ADD CONSTRAINT restaurant_user_follows_follower_id_fkey
    FOREIGN KEY (follower_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.restaurant_user_follows
  DROP CONSTRAINT IF EXISTS restaurant_user_follows_user_id_fkey,
  ADD CONSTRAINT restaurant_user_follows_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_favorites
  DROP CONSTRAINT IF EXISTS user_favorites_user_id_fkey,
  ADD CONSTRAINT user_favorites_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_checkins
  DROP CONSTRAINT IF EXISTS user_checkins_user_id_fkey,
  ADD CONSTRAINT user_checkins_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
```

### E-3 Hasura relationship — `restaurant_reviews → user_profiles`

`nhost/metadata/databases/default/tables/public_restaurant_reviews.yaml`:

```yaml
object_relationships:
  - name: author
    using:
      manual_configuration:
        remote_table:
          schema: public
          name: user_profiles
        column_mapping:
          author_id: user_id
```

This enables the nested `author { user_id username user { displayName avatarUrl } }`
pattern used in A-6 and A-7 without a separate lookup query.

### E-4 Drop `restaurant_users`

Only after `ripgrep restaurant_users functions/` returns zero matches and the FK
audit below returns 0 rows:

```sql
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu   USING (constraint_name, table_schema)
JOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name = 'restaurant_users';
-- Must return 0 rows

DROP TABLE public.restaurant_users;
```

Remove `nhost/metadata/databases/default/tables/public_restaurant_users.yaml`
and its entry from `tables.yaml`.

---

## 7. `api-guide.md` updates by phase

| Phase | Section | Change |
|---|---|---|
| A | §8.6 | Note all user responses now reflect `user_profiles` shape |
| B-1 | §8.6 | `create-restaurant-user` Auth column: `None` → `Bearer` |
| C-1 | §8.6 | Remove firebase-uuid row (already 410) |
| D-1 | §8.6 | Add `users/me \| GET \| Bearer \| Current user profile from JWT` |
| D-2 | §3.1 | Remove Firebase session mentions |
| E-4 | §11 | Remove `restaurant_users` from related docs |

---

## 8. Execution order

```
Phase A (reads)
  └─ merge + deploy
      └─ Phase B (writes)
           └─ merge + deploy
                └─ Phase C (stubs)
                     └─ merge + deploy
                          └─ Phase D (client/auth)
                               └─ merge + deploy + verify in production
                                    └─ Phase E (DB schema + drop)
                                         └─ maintenance window, DB snapshot first
```

Phase E is the only one requiring a maintenance window. All others are
zero-downtime deploys.

---

## 9. Definition of done

- [ ] `ripgrep restaurant_users functions/` returns zero matches
- [ ] All FK columns reference `auth.users(id)` — confirmed by E-2 audit queries
- [ ] `firebase_uuid` appears in zero active code paths (functions, hooks, services, mobile)
- [ ] `get-restaurant-user-by-firebase-uuid` returns `410` in production
- [ ] `user_profiles` has `deleted_at` and all E-1 gap columns
- [ ] `restaurant_reviews → user_profiles` Hasura relationship is deployed
- [ ] `restaurant_users` table does not exist in production
- [ ] `api-guide.md` reflects final state: no `restaurant_users` mentions,
      `users/me` listed, `create-restaurant-user` requires Bearer
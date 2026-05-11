# Decouple Plan — `tastyplates-v2-1` API → Nhost Functions

The goal is to move all business logic out of the Next.js `src/app/api/v1/` route handlers into `tastyplates-nhost/functions/` so that `tastyplates-v2-1` becomes a pure frontend.

Each Nhost function file maps directly to a URL:
`functions/<domain>/<action>.ts` → `{FUNCTIONS_URL}/v1/<domain>/<action>`

---

## Phases overview

| Phase | Scope | Risk | Prerequisite |
|-------|-------|------|-------------|
| 0 | Infrastructure (already done) | None | — |
| 1 | Reference data (categories, cuisines, palates, price ranges, locations) | Very low | Phase 0 |
| 2 | Restaurant reads + rating data | Low | Phase 0 |
| 3 | Review reads | Low | Phase 0 |
| 4 | User profile reads + social reads | Low | Phase 0 |
| 5 | Review mutations (create, update, delete, like, comment) | Medium | Phases 3–4 |
| 6 | User mutations (follow, create/update/delete, wishlist, checkin) | Medium | Phase 4 |
| 7 | Uploads + image utilities | High (S3 + Sharp) | Phase 0 |
| 8 | Admin + monitoring | Low | Phase 0 |
| 9 | Frontend migration — switch all calls from `/api/v1/` to `FUNCTIONS_URL` | Medium | All phases complete |

---

## Shared infrastructure to build before Phase 1

Before porting any handler, create these shared files under `functions/_lib/`:

| File | Purpose |
|------|---------|
| `_lib/hasura.ts` | `hasuraQuery<T>()` and `hasuraMutation<T>()` wrappers with admin-secret header + error unwrapping |
| `_lib/redis.ts` | (Phase 5+) Upstash Redis client instance, `cacheGetOrSet()`, `bumpVersion()`, rate-limit helpers |
| `_lib/cursor.ts` | (Phase 3+) `encodeReviewCursor()` / `decodeReviewCursor()` — ported from `@/lib/cursor-pagination` |

The `_lib/hasura.ts` wrapper should look like:
```typescript
// functions/_lib/hasura.ts
import process from 'node:process'
import { fail } from './respond'
import type { Response } from 'express'

const ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT!
const SECRET   = process.env.HASURA_GRAPHQL_ADMIN_SECRET!

export async function hasuraQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: unknown[] }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': SECRET,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json() as Promise<{ data: T | null; errors?: unknown[] }>
}

// same signature for mutations
export const hasuraMutation = hasuraQuery
```

---

## Phase 0 — Infrastructure (complete ✅)

Already built:

| Nhost function file | Route | What it does |
|--------------------|-------|--------------|
| `health.ts` | `GET /v1/health` | Liveness probe |
| `echo.ts` | `GET /v1/echo` | Auth smoke-test |
| `_lib/auth.ts` | — | JWT verification (HS256) |
| `_lib/respond.ts` | — | `ok()` / `fail()` |
| `_lib/validate.ts` | — | Zod validation wrapper |

**Test before moving on:** `curl {FUNCTIONS_URL}/v1/health` returns `{ "ok": true }`.

---

## Phase 1 — Reference data (read-only, no auth, no Redis)

These are simple passthrough reads. Port them first to validate the Hasura wrapper works end-to-end.

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `categories/get-categories` | `categories/get-categories.ts` | GET | No | List all categories |
| `categories/get-category-by-id` | `categories/get-category-by-id.ts` | GET | No | By `id` query param |
| `cuisines/get-cuisines` | `cuisines/get-cuisines.ts` | GET | No | List all cuisines |
| `cuisines/get-cuisine-by-id` | `cuisines/get-cuisine-by-id.ts` | GET | No | By `id` query param |
| `palates/get-palates` | `palates/get-palates.ts` | GET | No | List all palates |
| `palates/get-palate-by-id` | `palates/get-palate-by-id.ts` | GET | No | By `id` query param |
| `price-ranges/get-price-ranges` | `price-ranges/get-price-ranges.ts` | GET | No | List all price ranges |
| `price-ranges/get-price-range-by-id` | `price-ranges/get-price-range-by-id.ts` | GET | No | By `id` query param |
| `locations/get-locations` | `locations/get-locations.ts` | GET | No | Location hierarchy |

**Testing Phase 1:**
```bash
curl "{FUNCTIONS_URL}/v1/categories/get-categories"
curl "{FUNCTIONS_URL}/v1/palates/get-palates"
```
Both must return `{ "ok": true, "data": [...] }`.

---

## Phase 2 — Restaurant reads + rating data

Read-only routes. Add Redis caching to high-traffic ones (get-restaurants, get-rating-summary) once `_lib/redis.ts` exists.

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `restaurants-v2/get-restaurants` | `restaurants-v2/get-restaurants.ts` | GET | No | Filtering, sorting, cursor pagination, palate slug util. Cache. |
| `restaurants-v2/get-restaurant-by-id` | `restaurants-v2/get-restaurant-by-id.ts` | GET | No | By `id` or `slug` query param |
| `restaurants-v2/get-rating-summary` | `restaurants-v2/get-rating-summary.ts` | GET | No | Precomputed rating for one restaurant. Cache. |
| `restaurants-v2/get-authentic-stats` | `restaurants-v2/get-authentic-stats.ts` | GET | No | Authentic rating map. Cache. |
| `restaurants-v2/get-preference-stats` | `restaurants-v2/get-preference-stats.ts` | GET | No | Palate preference stats. Cache. |
| `restaurants-v2/match-restaurant` | `restaurants-v2/match-restaurant.ts` | POST | No | Name/address match for review creation |
| `restaurants-v2/test-connection` | `restaurants-v2/test-connection.ts` | GET | No | Hasura connectivity diagnostic; dev-only gate |
| `featured-restaurants` | `featured-restaurants.ts` | GET | No | Global featured list. Cache. |

**Testing Phase 2:**
```bash
curl "{FUNCTIONS_URL}/v1/restaurants-v2/get-restaurants?limit=10"
curl "{FUNCTIONS_URL}/v1/featured-restaurants"
```

---

## Phase 3 — Review reads

All read-only. Cursor pagination helpers (`_lib/cursor.ts`) needed for `get-all-reviews` and `get-following-feed`.

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `restaurant-reviews/get-all-reviews` | `restaurant-reviews/get-all-reviews.ts` | GET | No | Global feed, cursor pagination. Cache. |
| `restaurant-reviews/get-review-by-id` | `restaurant-reviews/get-review-by-id.ts` | GET | No | Single review by `id` |
| `restaurant-reviews/get-reviews-by-restaurant` | `restaurant-reviews/get-reviews-by-restaurant.ts` | GET | No | Restaurant's reviews. Cache. |
| `restaurant-reviews/get-user-reviews` | `restaurant-reviews/get-user-reviews.ts` | GET | No | Reviews by `author_id` query param |
| `restaurant-reviews/get-following-feed` | `restaurant-reviews/get-following-feed.ts` | GET | No | Feed from followed users; cursor. Cache. |
| `restaurant-reviews/get-replies` | `restaurant-reviews/get-replies.ts` | GET | No | Threaded replies. Cache. |
| `restaurant-reviews/get-draft-reviews` | `restaurant-reviews/get-draft-reviews.ts` | GET | **Yes (Bearer)** | Current user's drafts — derive user from JWT |

**Testing Phase 3:**
```bash
curl "{FUNCTIONS_URL}/v1/restaurant-reviews/get-all-reviews?limit=10"
curl -H "Authorization: Bearer <token>" \
  "{FUNCTIONS_URL}/v1/restaurant-reviews/get-draft-reviews"
```

---

## Phase 4 — User profile reads + social reads

All read-only. No auth required except `check-follow-status` and `suggested` (optional).

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `restaurant-users/get-restaurant-users` | `restaurant-users/get-restaurant-users.ts` | GET | No | Search/list users |
| `restaurant-users/get-restaurant-user-by-id` | `restaurant-users/get-restaurant-user-by-id.ts` | GET | No | User profile by UUID |
| `restaurant-users/get-restaurant-user-by-username` | `restaurant-users/get-restaurant-user-by-username.ts` | GET | No | User profile by username |
| `restaurant-users/get-restaurant-user-by-firebase-uuid` | `restaurant-users/get-restaurant-user-by-firebase-uuid.ts` | GET | No | **Return 410 Gone** — deprecated stub, keep to avoid 404s during transition |
| `restaurant-users/check-username` | `restaurant-users/check-username.ts` | GET | No | Username availability |
| `restaurant-users/get-followers-list` | `restaurant-users/get-followers-list.ts` | GET | No | Follower list |
| `restaurant-users/get-following-list` | `restaurant-users/get-following-list.ts` | GET | No | Following list |
| `restaurant-users/get-followers-count` | `restaurant-users/get-followers-count.ts` | GET | No | Follower count |
| `restaurant-users/get-following-count` | `restaurant-users/get-following-count.ts` | GET | No | Following count |
| `restaurant-users/get-wishlist` | `restaurant-users/get-wishlist.ts` | GET | No | User's saved restaurants |
| `restaurant-users/get-checkins` | `restaurant-users/get-checkins.ts` | GET | No | User's check-ins |
| `restaurant-users/get-reviews` | `restaurant-users/get-reviews.ts` | GET | No | User's reviews |
| `restaurant-users/suggested` | `restaurant-users/suggested.ts` | GET | Optional Bearer | Suggested users; personalise if token present. Cache. |
| `restaurant-users/check-follow-status` | `restaurant-users/check-follow-status.ts` | POST | **Yes (Bearer)** | Whether current user follows target |

**Testing Phase 4:**
```bash
curl "{FUNCTIONS_URL}/v1/restaurant-users/get-restaurant-user-by-username?username=moosii93"
curl -H "Authorization: Bearer <token>" \
  -X POST -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>"}' \
  "{FUNCTIONS_URL}/v1/restaurant-users/check-follow-status"
```

---

## Phase 5 — Review mutations

These are higher risk because they write data and need auth + rate limiting.
Add Redis rate limits before shipping these to production.

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `restaurant-reviews/create-review` | `restaurant-reviews/create-review.ts` | POST | **Yes (Bearer)** | Auth required — derive `author_id` from JWT, never trust body. Rate limit. Rebuild rating summary after. Bump cache version. |
| `restaurant-reviews/update-review` | `restaurant-reviews/update-review.ts` | PUT | **Yes (Bearer)** | Check review belongs to JWT user before updating. Bump cache version. |
| `restaurant-reviews/delete-review` | `restaurant-reviews/delete-review.ts` | DELETE | **Yes (Bearer)** | Soft-delete. Ownership check. Bump version. |
| `restaurant-reviews/create-comment` | `restaurant-reviews/create-comment.ts` | POST | **Yes (Bearer)** | Auth required. Rate limit. Bump version. |
| `restaurant-reviews/toggle-like` | `restaurant-reviews/toggle-like.ts` | POST, GET | **Yes (Bearer)** | POST: toggle; GET: like status. Rate limit on POST. |

**Security note on `create-review`:** The current Next.js implementation accepts `author_id` in the request body (caller-trusted). In the Nhost function, this must be replaced — always use `getUserId(payload)` from the JWT. Do not accept an `author_id` from the client.

---

## Phase 6 — User mutations + social actions

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `restaurant-users/create-restaurant-user` | `restaurant-users/create-restaurant-user.ts` | POST | No (called at signup) | Creates profile record after Nhost signup. No auth needed — verified against the Nhost user ID from the Hasura action/event. |
| `restaurant-users/update-restaurant-user` | `restaurant-users/update-restaurant-user.ts` | PUT | **Yes (Bearer)** | User updates own profile. Derive user from JWT. |
| `restaurant-users/delete-restaurant-user` | `restaurant-users/delete-restaurant-user.ts` | DELETE | **Yes (Bearer)** | Ownership check. Soft-delete. |
| `restaurant-users/follow` | `restaurant-users/follow.ts` | POST | **Yes (Bearer)** | Rate limit. Derive follower from JWT. |
| `restaurant-users/unfollow` | `restaurant-users/unfollow.ts` | POST | **Yes (Bearer)** | Rate limit. |
| `restaurant-users/toggle-favorite` | `restaurant-users/toggle-favorite.ts` | POST, GET | **Yes (Bearer)** | POST: toggle; GET: status. Rate limit on POST. |
| `restaurant-users/toggle-checkin` | `restaurant-users/toggle-checkin.ts` | POST, GET | **Yes (Bearer)** | POST: toggle; GET: status. Rate limit on POST. |
| `restaurants-v2/create-restaurant` | `restaurants-v2/create-restaurant.ts` | POST | **Yes (Bearer)** | Creates restaurant listing. Validate input. No direct S3 here — image URLs pass through as strings. |

**Security notes:**
- `follow` and `unfollow`: current implementation accepts `user_id` (the person to follow) in the body — this is fine, since it's the target. The follower/actor must always come from the JWT, never the body.
- `toggle-favorite` and `toggle-checkin`: same pattern — acting user from JWT, target restaurant from body.

---

## Phase 7 — Uploads + image utilities

Highest complexity. Requires adding S3 SDK and Sharp to `functions/package.json`.

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `upload/image` | `upload/image.ts` | POST | **Yes (Bearer)** | Multipart → Sharp optimize (AVIF-first, WebP fallback) → S3. Rate limit. |
| `upload/batch` | `upload/batch.ts` | POST | **Yes (Bearer)** | Multipart multi-file → S3 (no Sharp). Rate limit. |
| `images/download-google-photo` | `images/download-google-photo.ts` | POST | No | Proxy Google Places photo to base64. Rate limit. No S3 or Sharp. |
| `articles/get-articles` | `articles/get-articles.ts` | GET | No | List articles; location filter, pagination. Cache. |
| `articles/get-article-by-slug` | `articles/get-article-by-slug.ts` | GET | No | Article by slug. Cache. |
| `articles/get-article-by-id` | `articles/get-article-by-id.ts` | GET | No | Article by id. Cache. |
| `content/[type]` | `content/[type].ts` | GET | No | Static markdown pages (legal, ToS, etc.) — load from `_lib/content/` or env-hosted content |

**Note on `content/[type]`:** The current implementation uses `markdownLoader` which reads files from disk. In Nhost Functions, file access is limited. Options:
1. Move the markdown content into the Hasura DB as a table.
2. Serve from a CDN/storage URL and proxy.
3. Keep this route in Next.js as a static/ISR page (simplest — legal pages don't need backend migration).

Recommendation: **keep `content/[type]` in Next.js** for now. Migrate only if there's a clear reason.

**New packages needed for Phase 7:**
```bash
# Inside functions/
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner sharp busboy
npm install --save-dev @types/busboy
```

**Additional env vars for Phase 7:**
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
AWS_S3_BUCKET
IMAGE_MAX_WIDTH
IMAGE_MAX_HEIGHT
IMAGE_AVIF_QUALITY
IMAGE_WEBP_QUALITY
```

---

## Phase 8 — Admin + monitoring

Low priority. Port last.

| Next.js route | Nhost function file | Methods | Auth | Notes |
|--------------|---------------------|---------|------|-------|
| `admin/backfill-rating-summary` | `admin/backfill-rating-summary.ts` | POST | Admin secret header | Verify `x-admin-secret` matches env. Not user JWT. |
| `monitoring/graphql-stats` | `monitoring/graphql-stats.ts` | GET | Dev gate | Guard with `NODE_ENV !== 'production'` or a secret header. In-memory stats are per-instance; not useful in serverless anyway — consider removing entirely. |

---

## Phase 9 — Frontend migration (tastyplates-v2-1)

Once all Nhost functions are deployed and smoke-tested, update the frontend to stop calling `/api/v1/` and call the Nhost Functions URL instead.

### Step 1 — Add the functions base URL to the frontend environment

```bash
# tastyplates-v2-1/.env.local
NEXT_PUBLIC_FUNCTIONS_URL=https://<subdomain>.functions.<region>.nhost.run/v1
```

Add this to `.env` for production and `.env.local` for local dev (pointing at `https://local.functions.local.nhost.run/v1` when running `nhost dev`).

### Step 2 — Create a central API client module

Create `tastyplates-v2-1/src/lib/api.ts`:

```typescript
// tastyplates-v2-1/src/lib/api.ts
const BASE = process.env.NEXT_PUBLIC_FUNCTIONS_URL

if (!BASE) throw new Error('NEXT_PUBLIC_FUNCTIONS_URL is not set')

export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { token?: string },
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { token, ...fetchOptions } = options ?? {}
  const res = await fetch(`${BASE}${path}`, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
  })
  return res.json()
}
```

### Step 3 — Migrate service files one domain at a time

The existing `tastyplates-v2-1/src/app/api/v1/services/` files call `fetch('/api/v1/...')`. Update each one to call `apiFetch('/domain/action', ...)` instead.

**Migration order (matches phases above):**

| Phase | Services to update |
|-------|--------------------|
| 1 | `categoryService.ts`, `cuisineService.ts`, `palateService.ts`, `priceRangeService.ts` |
| 2 | `restaurantV2Service.ts` |
| 3 | `reviewV2Service.ts` (read methods first) |
| 4 | `restaurantUserService.ts` (read methods first) |
| 5 | `reviewV2Service.ts` (mutation methods) |
| 6 | `restaurantUserService.ts` (mutation methods) |
| 7 | Upload calls in `UploadContext`, `ImagePicker`, etc. |

### Step 4 — Handle auth token in service calls

The Nhost session token is available from `nhost.auth.getSession()?.accessToken`. Pass it through `apiFetch` where needed:

```typescript
// Example service call with auth
const session = nhost.auth.getSession()
const result = await apiFetch<Review>('/restaurant-reviews/create-review', {
  method: 'POST',
  token: session?.accessToken,
  body: JSON.stringify({ restaurantId, rating, body }),
})
```

### Step 5 — Remove Next.js API routes

Once all frontend callers are migrated and the Nhost functions are confirmed stable in production:

1. Delete `tastyplates-v2-1/src/app/api/v1/` entirely.
2. Delete `tastyplates-v2-1/src/app/api/v1/services/` — replaced by the `apiFetch` client.
3. Remove server-only libraries that are no longer needed in the frontend:
   - `src/app/graphql/hasura-server-client.ts`
   - `src/lib/nhost-server-auth.ts`
   - `src/lib/redis-cache.ts`, `redis-versioning.ts`, `redis-ratelimit.ts`
   - `src/lib/rebuildRatingSummary.ts`
4. Remove server-only dependencies from `tastyplates-v2-1/package.json`:
   - `jsonwebtoken`, `jwks-rsa`, `@upstash/redis`, `@aws-sdk/client-s3`, `sharp`, `busboy`

### Step 6 — Smoke-test the full decoupled stack

```bash
# 1. Confirm Nhost functions are live
curl "{FUNCTIONS_URL}/v1/health"

# 2. Load the home feed in the browser — reviews, restaurants, featured
# 3. Sign in → load profile page → follower/following counts
# 4. Submit a new review with a photo
# 5. Toggle like on a review
# 6. Follow a user
# 7. Confirm the following feed updates
```

### What stays in Next.js forever

These should never be migrated to Nhost Functions:

| What | Why |
|------|-----|
| `content/[type]` route (legal pages) | Static markdown — better as Next.js pages or ISR |
| `src/app/api/auth/error/page.tsx` | Next.js auth error page — UI concern |
| All page components, layouts, hooks | Frontend — no backend logic |
| Nhost Auth configuration | Handled by Nhost service itself, not functions |

---

## Dependency summary for `functions/package.json`

| Phase | New `dependencies` to add |
|-------|--------------------------|
| Before Phase 1 | _(none — hasura.ts uses native `fetch`)_ |
| Phase 7 | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `sharp`, `busboy` |
| Phase 5–6 (Redis) | `@upstash/redis` |

Current dependencies (already in `package.json`):
- `jsonwebtoken` — JWT verification
- `zod` — input validation

# Tastyplates Nhost Functions — API Guide

This document describes every HTTP function exposed by `tastyplates-nhost/functions`, how URLs are formed, how authentication works, and how to call the API from a frontend or backend client.

For code-writing rules, see [AI_rules.md](./AI_rules.md). For migration context from Next.js `/api/v1`, see [decouple-plan.md](./decouple-plan.md). For Hasura metadata, deploy, and troubleshooting, see [api-doc-v2.md](./api-doc-v2.md).

---

## 1. How routing works

Nhost maps each file under `functions/` to an HTTP route. Internal paths like `_lib/` are not exposed.

| Source file | URL path after the version segment |
|---|---|
| `health.ts` | `health` |
| `featured-restaurants.ts` | `featured-restaurants` |
| `categories/get-categories.ts` | `categories/get-categories` |
| `restaurant-reviews/create-review.ts` | `restaurant-reviews/create-review` |

Full pattern:

```text
{FUNCTIONS_BASE}/{API_VERSION}/{path}
```

In the [Nhost dashboard](https://app.nhost.io), copy the Functions base URL shown for your project. Some projects expose `/v1`, others `/v0`. Do not duplicate the version segment. If your env var already ends with `/v1`, append `health`, not `v1/health`.

Examples:

```text
https://<subdomain>.functions.<region>.nhost.run/v1/health
https://<subdomain>.functions.<region>.nhost.run/v1/categories/get-categories
```

Local development uses the same path rules with the URL printed by `nhost up`.

---

## 2. Response envelope

All handlers use the shared helpers in `functions/_lib/respond.ts`.

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "error": "Human-readable message",
  "details": null
}
```

`details` is optional, usually for validation issues on `422`. Always check `ok` before reading `data`.

Common statuses:

| Status | Meaning |
|---|---|
| `200` | Success |
| `201` | Created |
| `400` | Missing or invalid query/body input |
| `401` | Missing or invalid Bearer token |
| `403` | Authenticated but not allowed |
| `404` | Not found or intentionally hidden private resource |
| `410` | Deprecated endpoint stub |
| `422` | Validation failed |
| `500` | Server / Hasura error |

---

## 3. Authentication

### 3.1 User Bearer token

Protected routes expect:

```http
Authorization: Bearer <access_token>
```

The token is the Nhost access token from the logged-in user.

This project currently verifies JWTs with **HS256**. The secret is configured in `nhost.toml` as `HASURA_GRAPHQL_JWT_SECRET`; in the Functions runtime Nhost exposes that as `NHOST_JWT_SECRET` JSON, and the shared env helper extracts the signing key before verification.

Authorization decisions are made from the verified Hasura claims inside the JWT, especially `x-hasura-user-id`. Do not rely on caller-supplied `user_id`, `author_id`, `follower_id`, or similar fields for ownership decisions.

### 3.2 Conditional auth routes

Some read routes are public by default but become private when a caller asks for owner-only data:

- `restaurant-reviews/get-review-by-id`: approved reviews are public; non-approved reviews require a valid Bearer token for the review owner.
- `restaurant-reviews/get-user-reviews`: approved reviews are public; `status=draft` or `status=pending` requires the owner’s Bearer token.
- `restaurant-users/get-reviews`: same behavior as `get-user-reviews`, but keyed by `user_id`.
- `restaurant-users/suggested`: Bearer is optional; if present and valid, the current user is excluded from suggestions.

### 3.3 Required-owner Bearer routes

These routes always require a valid Bearer token and reject cross-user access:

- `restaurant-reviews/get-following-feed`
- `restaurant-users/get-wishlist`
- `restaurant-users/get-checkins`
- all write / toggle / upload routes that mutate user data

### 3.4 Admin secret

`admin/backfill-rating-summary` does not use a user JWT. It expects:

```http
x-admin-secret: <value of HASURA_GRAPHQL_ADMIN_SECRET>
```

Operational note: in the Functions runtime this is read as `NHOST_ADMIN_SECRET` by `_lib/env.ts`, with a fallback to the legacy name for local or transitional setups.

Treat this as a root credential. Only trusted tooling or internal jobs should call it.

---

## 4. Runtime configuration and secrets

The functions runtime gets a mix of Nhost system variables and project secrets. For cloud deploys, set secrets in the Nhost dashboard. For local `nhost up`, put them in the repo-root `.secrets` file.

| Secret / config source | Runtime variable inside Functions | Used for |
|---|---|---|
| `HASURA_GRAPHQL_ADMIN_SECRET` | `NHOST_ADMIN_SECRET` | Admin Hasura calls, admin route header checks |
| `HASURA_GRAPHQL_JWT_SECRET` | `NHOST_JWT_SECRET` | HS256 JWT verification |
| `HASURA_GRAPHQL_ENDPOINT` | `HASURA_GRAPHQL_ENDPOINT` | Optional explicit GraphQL URL override |
| Nhost platform | `NHOST_GRAPHQL_URL` | Preferred GraphQL endpoint |
| Nhost platform | `NHOST_SUBDOMAIN`, `NHOST_REGION` | Runtime metadata and GraphQL URL fallback |
| project secrets | `S3_*`, `IMAGE_*`, etc. | Upload and image processing |

Important details:

- `.secrets` belongs at the repo root, not inside `functions/`.
- Nhost Functions does not rely on dotenv files inside `functions/`.
- `NHOST_JWT_SECRET` is a JSON payload such as `{"key":"...","type":"HS256"}`, not a raw secret string.
- If you update a secret in cloud, redeploy the functions so cold-start env resolution picks it up.

---

## 5. Request bodies and methods

- **JSON:** Send `Content-Type: application/json` for handlers that read `req.body`.
- **Query string:** Most read handlers use URL search params and are naturally `GET`.
- **Multipart:** `upload/image` and `upload/batch` expect `multipart/form-data`, not JSON.

Nhost forwards the original HTTP method to Express. A few handlers intentionally branch on `req.method`.

---

## 6. Client implementation guide

### 6.1 Plain `fetch`

```typescript
const FUNCTIONS_BASE = process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL!.replace(/\/$/, '')

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string; details?: unknown }

export async function tastyplatesFetch<T>(
  path: string,
  init: RequestInit & { accessToken?: string | null } = {},
): Promise<Envelope<T>> {
  const { accessToken, headers: h, ...rest } = init
  const headers = new Headers(h)

  if (!headers.has('Content-Type') && rest.body && typeof rest.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`)
  }

  const res = await fetch(`${FUNCTIONS_BASE}/${path.replace(/^\//, '')}`, {
    ...rest,
    headers,
  })

  return res.json() as Promise<Envelope<T>>
}
```

Assume `FUNCTIONS_BASE` already includes the version segment if your environment variable was copied that way from Nhost.

### 6.2 Nhost JavaScript client

```typescript
import { nhost } from '@/lib/nhost'

const accessToken = nhost.auth.getAccessToken()
const res = await fetch(
  `${process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL}/restaurant-reviews/get-draft-reviews`,
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  },
)
const json = await res.json()
```

### 6.3 Multipart upload

```typescript
const form = new FormData()
form.append('file', fileBlob, 'photo.jpg')

const res = await fetch(`${base}/upload/image`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: form,
})
```

Do not set `Content-Type` manually for multipart uploads; the browser will set the boundary.

### 6.4 CORS

Browser requests from a different origin than the functions host require CORS to allow your frontend origin. Server-side requests from Next.js or Node are not subject to browser CORS restrictions.

---

## 7. Special handler behavior

| Route | Notes |
|---|---|
| `restaurant-reviews/toggle-like` | `GET` is a public check using query params; `POST` requires Bearer and toggles for the JWT user. |
| `restaurant-users/toggle-favorite` | `GET` and `POST` both require Bearer; accepts `restaurant_uuid` and/or `restaurant_slug`. |
| `restaurant-users/toggle-checkin` | `GET` and `POST` both require Bearer; same lookup pattern as toggle-favorite. |
| `restaurant-reviews/delete-review` | Uses query param `id` plus Bearer; ownership enforced server-side. |
| `restaurant-users/delete-restaurant-user` | Supports `hard=true` for hard delete; Bearer required. |
| `restaurant-reviews/get-review-by-id` | Returns approved reviews publicly; non-approved reviews are only visible to the author via Bearer. |
| `restaurant-reviews/get-user-reviews` | Public approved reviews by default; `status=draft` or `status=pending` is owner-only. |
| `restaurant-users/get-reviews` | Same privacy rules as `restaurant-reviews/get-user-reviews`, keyed by `user_id`. |
| `restaurant-users/get-wishlist` | Bearer required; `user_id` must match the JWT user. |
| `restaurant-users/get-checkins` | Bearer required; `user_id` must match the JWT user. |
| `restaurant-reviews/get-following-feed` | Bearer required; `user_id` must match the JWT user. |
| `restaurants-v2/test-connection` | Returns `403` when `NODE_ENV === 'production'`. |
| `monitoring/graphql-stats` | Returns `403` in production. |
| `restaurant-users/get-restaurant-user-by-firebase-uuid` | Always `410`; migrate callers to UUID or username routes. |
| `echo` | Auth smoke test only; remove or lock down before heavy production use. |

---

## 8. Endpoint catalog

Below, `Path` is the segment appended after the functions version segment.

Legend for `Auth`: `None`, `Bearer`, `Optional Bearer`, `Admin header`

### 8.1 Core

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `health` | GET | None | Liveness: service name, Node version, uptime |
| `echo` | GET | Bearer | Returns JWT user id and role; debugging only |

### 8.2 Featured and reference data

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `featured-restaurants` | GET | None | Active featured restaurants |
| `categories/get-categories` | GET | None | List categories; supports filters and pagination |
| `categories/get-category-by-id` | GET | None | Query param `id` |
| `cuisines/get-cuisines` | GET | None | List cuisines |
| `cuisines/get-cuisine-by-id` | GET | None | Query param `id` |
| `palates/get-palates` | GET | None | List palates |
| `palates/get-palate-by-id` | GET | None | Query param `id` |
| `price-ranges/get-price-ranges` | GET | None | List price ranges |
| `price-ranges/get-price-range-by-id` | GET | None | Query param `id` |
| `locations/get-locations` | GET | None | Location hierarchy / list |

### 8.3 Restaurants (`restaurants-v2/`)

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `restaurants-v2/get-restaurants` | GET | None | List and filter restaurants |
| `restaurants-v2/get-restaurant-by-id` | GET | None | Query `id` and/or `slug` |
| `restaurants-v2/get-rating-summary` | GET | None | Rating summary for one restaurant |
| `restaurants-v2/get-authentic-stats` | GET | None | Authentic stats map |
| `restaurants-v2/get-preference-stats` | GET | None | Palate preference stats |
| `restaurants-v2/match-restaurant` | POST | None | Body: `placeId` and/or `name` plus `address` |
| `restaurants-v2/test-connection` | GET | None | Dev-only Hasura connectivity check |
| `restaurants-v2/create-restaurant` | POST | Bearer | Creates a restaurant from validated JSON body |

### 8.4 Reviews — reads (`restaurant-reviews/`)

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `restaurant-reviews/get-all-reviews` | GET | None | Global feed / pagination |
| `restaurant-reviews/get-review-by-id` | GET | Optional Bearer | Approved reviews are public; non-approved are owner-only |
| `restaurant-reviews/get-reviews-by-restaurant` | GET | None | Reviews by restaurant |
| `restaurant-reviews/get-user-reviews` | GET | Optional Bearer | Approved reviews public; private statuses require owner Bearer |
| `restaurant-reviews/get-following-feed` | GET | Bearer | Feed for the authenticated user’s follows |
| `restaurant-reviews/get-replies` | GET | None | Thread replies for a review |
| `restaurant-reviews/get-draft-reviews` | GET | Bearer | Current user’s drafts |

List/detail review handlers query Hasura via the **`author`** relationship (`restaurant_reviews` → `user_profiles`), then run **`_lib/review-enrichment.ts`**: merge nested `author` into response **`AuthorProfile`**, batch-fill missing profiles, and attach `restaurant: { uuid, title, slug }` on feed-style endpoints (`get-following-feed`, `get-user-reviews`, `restaurant-users/get-reviews`, drafts). Mobile clients should read **`AuthorProfile`** (not legacy `restaurant_users`).

### 8.5 Reviews — writes (`restaurant-reviews/`)

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `restaurant-reviews/create-review` | POST | Bearer | Create review with validated JSON body |
| `restaurant-reviews/update-review` | POST | Bearer | Update review by `id` |
| `restaurant-reviews/delete-review` | GET / DELETE | Bearer | Delete review by query `id` |
| `restaurant-reviews/create-comment` | POST | Bearer | Create comment on a review |
| `restaurant-reviews/toggle-like` | GET / POST | GET: None, POST: Bearer | Public check and authenticated toggle |

### 8.6 Users and social (`restaurant-users/`)

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `restaurant-users/create-restaurant-user` | POST | Bearer | Creates `user_profiles` for the authenticated user (JWT `user_id` only) |
| `users/me` | GET | Bearer | Current user profile from JWT (`user_profiles` + `auth.users`) |
| `restaurant-users/update-restaurant-user` | POST | Bearer | Update current user profile (`user_profiles` + `auth.users` avatar/locale/displayName) |
| `restaurant-users/delete-restaurant-user` | POST | Bearer | Delete current user; `hard=true` optional |
| `restaurant-users/follow` | POST | Bearer | Follow another user |
| `restaurant-users/unfollow` | POST | Bearer | Unfollow another user |
| `restaurant-users/check-follow-status` | POST | Bearer | Compare target user against JWT follower |
| `restaurant-users/toggle-favorite` | GET / POST | Bearer | Read or toggle favorite state |
| `restaurant-users/toggle-checkin` | GET / POST | Bearer | Read or toggle check-in state |
| `restaurant-users/suggested` | GET | Optional Bearer | Suggestions; current user excluded if Bearer is present |
| `restaurant-users/get-restaurant-users` | GET | None | List and search users (`user_profiles` + nested `auth.users`) |
| `restaurant-users/get-restaurant-user-by-id` | GET | None | Fetch one user by UUID (`user_profiles`) |
| `restaurant-users/get-restaurant-user-by-username` | GET | None | Fetch one user by username (`user_profiles`) |
| `restaurant-users/get-restaurant-user-by-firebase-uuid` | GET | None | Returns `410 Gone`; use id or username routes |
| `restaurant-users/check-username` | GET | None | Username availability |
| `restaurant-users/get-followers-list` | GET | None | Followers list |
| `restaurant-users/get-following-list` | GET | None | Following list |
| `restaurant-users/get-followers-count` | GET | None | Followers count |
| `restaurant-users/get-following-count` | GET | None | Following count |
| `restaurant-users/get-wishlist` | GET | Bearer | Wishlist for the authenticated user only |
| `restaurant-users/get-checkins` | GET | Bearer | Check-ins for the authenticated user only |
| `restaurant-users/get-reviews` | GET | Optional Bearer | Approved reviews public; private statuses require owner Bearer |

### 8.7 Uploads and images

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `upload/image` | POST | Bearer | Multipart image → Sharp → Nhost Storage (`tasty-bucket`) + `media_assets` catalog |
| `upload/batch` | POST | Bearer | Multipart batch upload (same pipeline per file) |
| `admin/migrate-media` | POST | `x-admin-secret` | Migrate legacy S3 URLs on profiles/lists to Nhost Storage |
| `images/download-google-photo` | POST | None | Download Google photo URL and return data URL |

### 8.8 Articles

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `articles/get-articles` | GET | None | List with filters and pagination |
| `articles/get-article-by-slug` | GET | None | Query `slug`; **`published`** only. Tries **detail** GraphQL (associations + author); on Hasura error falls back to **simple** (no associations). Uses **`_ilike`** only when slug has no `_`/`%`. Response: **`data.article`** + **`data.articleMeta.restaurantEnrichment`** (`skipped` \| `ok` \| `partial` \| `failed`). Associations merged with batch **`restaurants`** incl. **`content`**. |
| `articles/get-article-by-id` | GET | None | Query `id` (integer); **published + not deleted** only (same as slug). **`author_profile`** + associations + **`articleMeta`**. Unpublished/draft/removed → **404**. |

**Article detail response shape** (`ok: true`):

```json
{
  "ok": true,
  "data": {
    "article": { "...": "article fields + article_restaurant_associations[].restaurant" },
    "articleMeta": {
      "restaurantEnrichment": "skipped"
    }
  }
}
```

- **`restaurantEnrichment`:** `skipped` — no associations or nothing to batch; `ok` — every `restaurant_id` resolved to a row; `partial` — batch ran but some IDs missing or unresolved; **`failed`** — batch GraphQL error (associations returned without merged `restaurant` objects).

### 8.9 Admin and monitoring

| Path | Typical method | Auth | Description |
|---|---|---|---|
| `admin/backfill-rating-summary` | POST | Admin header | Rebuild rating summaries |
| `monitoring/graphql-stats` | GET | None | Monitoring stub; `403` in production |

---

## 9. Testing with `curl`

Replace `BASE` with your real functions URL ending in the version segment, usually `/v1`.

```bash
curl -sS "$BASE/health" | jq .

curl -sS "$BASE/categories/get-categories?limit=5" | jq .

curl -sS -X POST "$BASE/restaurants-v2/match-restaurant" \
  -H "Content-Type: application/json" \
  -d '{"name":"Some Place","address":"123 Main"}' | jq .

curl -sS "$BASE/restaurant-reviews/get-draft-reviews" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

For the admin route:

```bash
curl -sS -X POST "$BASE/admin/backfill-rating-summary" \
  -H "x-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" | jq .
```

---

## 8. Restaurant lists (user-curated playlists)

User-owned, named playlists of restaurants — a separate product from the
To-Dine/Check-ins buckets in My Lists. Editorial rows (`owner_id IS NULL`)
coexist in the same tables and are unaffected by these endpoints.

All write endpoints require `Authorization: Bearer <access_token>`.
Read endpoints for public content require no auth.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `restaurant-lists/get-my-lists` | Bearer | Owner's lists with per-list `items_count` and cover (`display_pic`) |
| `POST` | `restaurant-lists/claim-lists` | Bearer | Set `owner_id` on orphan lists (`owner_id` was NULL) |
| `POST` | `restaurant-lists/create-list` | Bearer | Create list; server generates slug + share_token |
| `PATCH` | `restaurant-lists/update-list` | Bearer | Edit title, description, is_public, display_pic |
| `DELETE` | `restaurant-lists/delete-list` | Bearer | Delete list and all its items |
| `POST` | `restaurant-lists/add-item` | Bearer | Add restaurant to a list (TP uuid or Google place_id) |
| `DELETE` | `restaurant-lists/remove-item` | Bearer | Remove item by item_id |
| `PATCH` | `restaurant-lists/reorder-items` | Bearer | Bulk-update sort_order |
| `GET` | `restaurant-lists/get-list-by-slug?slug=` | Optional Bearer | Public or owner-only list by slug |
| `GET` | `restaurant-lists/get-list-by-uuid?uuid=` | Optional Bearer | Same as get-list-by-slug; keyed by list uuid |
| `GET` | `restaurant-lists/get-list-by-share-token?token=` | None | Capability-URL access for private lists |
| `GET` | `restaurant-lists/get-public-lists?page=&limit=` | None | Paginated community lists |
| `POST` | `restaurant-lists/regenerate-share-token` | Bearer | Invalidate old share link; issue new token |

### Request/response reference

**`GET get-my-lists`** — filters `recommended_restaurant_lists` where
`owner_id` equals the JWT `x-hasura-user-id` (same as `auth.users.id`).
Lists created in the Console without `owner_id` will not appear until claimed.

Response fields:
- `items_count` — count of rows in `recommended_restaurant_list_items` for that list
  (nested `recommended_restaurant_list_items_aggregate` on `recommended_restaurant_lists`).
- `display_pic` — user-supplied cover image URL stored on the list row (text column). Set via `POST upload/image` → `fileUrl`, then `POST create-list` or `PATCH update-list` with that HTTPS URL.
- `cover_image_url` — `display_pic` when set; otherwise null (first-item restaurant photo
  fallback can be added later via nested `recommended_restaurant_list_items`).

**Hasura prerequisite:** Array relationship `recommended_restaurant_list_items` on
`recommended_restaurant_lists` (FK `list_id`). Defined in repo metadata
`Repo/metadata/databases/default/tables/public_recommended_restaurant_lists.yaml`.
Apply via Hasura Console (Relationships → track FK) or `hasura metadata apply`.
Without it, nested aggregate queries return validation errors.

**`POST claim-lists`** — for playlists inserted without `owner_id`:
```json
// Request
{ "list_uuids": ["...", "..."] }

// Response
{
  "ok": true,
  "data": {
    "owner_id": "<your-user-uuid>",
    "claimed": [ { "uuid": "...", "title": "...", "owner_id": "..." } ],
    "claimed_count": 2,
    "skipped_count": 0
  }
}
```
Only rows with `owner_id IS NULL` and a matching `uuid` are updated.
`skipped_count` counts uuids that were already owned or not found.

**`POST create-list`**
```json
// Request body (display_pic optional — HTTPS URL from POST upload/image)
{ "title": "Best Ramen in HK", "description": "...", "is_public": false, "display_pic": "https://..." }

// Response 201
{
  "ok": true,
  "data": {
    "list": {
      "id": 42, "uuid": "...", "slug": "best-ramen-in-hk-x3f9a2",
      "title": "Best Ramen in HK", "is_public": false,
      "share_token": "dGhpcyBpcyBhIHRlc3Q",
      "created_at": "..."
    }
  }
}
```

`share_token` is ~22-character base64url (128-bit entropy). Treat it as a
secret. It is returned **only** to the owner (via `create-list`,
`get-my-lists`, `get-list-by-slug` when caller is owner).

**`POST add-item`**
```json
// Add a linked TP listing
{ "list_uuid": "...", "restaurant_uuid": "..." }

// Add a Google place (place_name required — upserts google_place_cache for list display)
{
  "list_uuid": "...",
  "google_place_id": "ChIJ...",
  "place_name": "Restaurant Name",
  "place_address": "123 Main St, Toronto, ON, Canada",
  "place_photo_url": "https://...",
  "place_rating": 4.5,
  "place_latitude": 43.65,
  "place_longitude": -79.38,
  "restaurant_uuid": "...",
  "restaurant_slug": "slug"
}

// Duplicate → 409
```

**`PATCH reorder-items`**
```json
{
  "list_uuid": "...",
  "order": [
    { "item_id": 1, "sort_order": 0 },
    { "item_id": 3, "sort_order": 1 },
    { "item_id": 2, "sort_order": 2 }
  ]
}
```

**`GET get-list-by-slug`** — items include resolved `name`, `slug`,
`image_url`, `address`, `rating` (from TP table or `google_place_cache`).

**`GET get-list-by-share-token`** — no auth required; `share_token` is
omitted from the response body. Wrong token always returns 404 (no info leak).

### Share-link URL shapes

| Style | URL | Notes |
|-------|-----|-------|
| Dedicated path (preferred) | `https://tastyplates.co/lists/share/{token}` | No ambiguity with slug route |
| Query param | `https://tastyplates.co/lists/{slug}?token={token}` | Resolver tries token first |

### curl QA examples

```bash
BASE="${NHOST_FUNCTIONS_BASE}"
TOKEN="your_access_token"

# Claim orphan lists (Console-created rows missing owner_id)
curl -sS -X POST "$BASE/restaurant-lists/claim-lists" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"list_uuids":["<uuid-1>","<uuid-2>"]}' | jq .

# Create a private list
curl -sS -X POST "$BASE/restaurant-lists/create-list" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hidden Gems","is_public":false}' | jq .

# Capture uuid and share_token from above response, then:
LIST_UUID="<uuid from response>"
SHARE_TOKEN="<share_token from response>"

# Get the list as owner (share_token included in response)
curl -sS "$BASE/restaurant-lists/get-list-by-slug?slug=hidden-gems-xxxxxx" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Access the private list via share link — no auth required
curl -sS "$BASE/restaurant-lists/get-list-by-share-token?token=$SHARE_TOKEN" | jq .
# Expected: 200 with list + items, share_token omitted from response body

# Wrong token → 404
curl -sS "$BASE/restaurant-lists/get-list-by-share-token?token=wrongtoken" | jq .
# Expected: { "ok": false, "error": "List not found" }

# Get the list without auth → 404 (private)
curl -sS "$BASE/restaurant-lists/get-list-by-slug?slug=hidden-gems-xxxxxx" | jq .
# Expected: { "ok": false, "error": "List not found" }

# Make the list public, then GET by slug without auth → 200
curl -sS -X PATCH "$BASE/restaurant-lists/update-list" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"list_uuid\":\"$LIST_UUID\",\"is_public\":true}" | jq .

# Browse community lists
curl -sS "$BASE/restaurant-lists/get-public-lists?page=0&limit=10" | jq .

# Regenerate share link (old link instantly invalid)
curl -sS -X POST "$BASE/restaurant-lists/regenerate-share-token" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"list_uuid\":\"$LIST_UUID\"}" | jq .

# Verify editorial list (owner_id IS NULL) is unaffected by user APIs
# (Attempt to update an editorial list returns 404 — owner check fails)
curl -sS -X PATCH "$BASE/restaurant-lists/update-list" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"list_uuid":"<editorial-list-uuid>","title":"hack"}' | jq .
# Expected: { "ok": false, "error": "List not found" }
```

---

## 9. Operational checklist (was §10)

1. **Secrets:** Dashboard or local `.secrets` contains `HASURA_GRAPHQL_ADMIN_SECRET` and `HASURA_GRAPHQL_JWT_SECRET`.
2. **Functions URL:** `NEXT_PUBLIC_NHOST_FUNCTIONS_URL` matches the dashboard URL and version concatenation rules from section 1.
3. **Redeploy after secret changes:** Cold-start env resolution should pick up the latest values.
4. **Lock down `echo`:** It is useful for smoke testing but should not stay broadly exposed forever.
5. **Public-entry routes:** Revisit rate limiting or edge protections for routes that may be abused.
6. **`create-restaurant-user`:** If this remains public, consider restricting it to your signup pipeline over time.

---

## 10. Related docs

| Document | Purpose |
|---|---|
| [AI_rules.md](./AI_rules.md) | Non-negotiable implementation rules for functions |
| [decouple-plan.md](./decouple-plan.md) | Migration plan from Next.js `/api/v1` |

When in doubt about the exact contract for a route, open the matching handler under `functions/`.

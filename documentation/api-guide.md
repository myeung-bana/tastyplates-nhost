# Tastyplates Nhost Functions — API Guide

This document describes every HTTP function exposed by `tastyplates-nhost/functions`, how URLs are formed, how to authenticate, and how to call the API from a frontend or backend client.

For coding rules when adding or changing handlers, see [AI_rules.md](./AI_rules.md). For migration context from Next.js `/api/v1`, see [decouple-plan.md](./decouple-plan.md).

---

## 1. How routing works

Nhost maps each file under `functions/src/` to an HTTP route. The `_lib/` directory is **not** exposed.

| Source file | URL path (after the functions version segment) |
|-------------|--------------------------------------------------|
| `src/health.ts` | `health` |
| `src/featured-restaurants.ts` | `featured-restaurants` |
| `src/categories/get-categories.ts` | `categories/get-categories` |
| `src/restaurant-reviews/create-review.ts` | `restaurant-reviews/create-review` |

**Full URL pattern:**

```text
{FUNCTIONS_BASE}/{API_VERSION}/{path-from-table-above}
```

**Determining `FUNCTIONS_BASE` and `API_VERSION`:** In the [Nhost dashboard](https://app.nhost.io), open your project → **Functions** and copy the base URL shown for deployed functions. It may end with `/v1` or `/v0` depending on the project generation date. Do **not** duplicate the version segment (if your env var already ends with `/v1`, append only `health`, not `v1/health`).

Example (when the dashboard base is `https://<subdomain>.functions.<region>.nhost.run` and the API version is `v1`):

```text
https://<subdomain>.functions.<region>.nhost.run/v1/health
https://<subdomain>.functions.<region>.nhost.run/v1/categories/get-categories
```

Local development with `nhost dev` uses the CLI’s printed functions URL; the same path rules apply.

---

## 2. Response envelope

All handlers use the shared helpers in `functions/src/_lib/respond.ts`.

**Success**

```json
{
  "ok": true,
  "data": { }
}
```

**Error**

```json
{
  "ok": false,
  "error": "Human-readable message",
  "details": null
}
```

`details` is optional (for example Zod validation issues on `422`). Always check `ok` before reading `data`.

Common HTTP status codes:

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request (missing/invalid query or body) |
| `401` | Missing/invalid `Authorization: Bearer` |
| `403` | Forbidden (e.g. dev-only route in production) |
| `410` | Gone (deprecated endpoint stub) |
| `422` | Validation failed (Zod); see `details` |
| `500` | Server / Hasura error |

---

## 3. Authentication

### 3.1 User JWT (Nhost Auth)

Protected routes expect:

```http
Authorization: Bearer <access_token>
```

The token is the **Nhost access token** (JWT) from the logged-in user. The server verifies it with **HS256** using `HASURA_GRAPHQL_JWT_SECRET` (same secret configured in `nhost.toml` for Hasura JWT mode).

The acting user id is taken **only** from the verified JWT (`x-hasura-user-id` inside `https://hasura.io/jwt/claims`). Do not send `author_id` / `follower_id` etc. for authorization decisions; those fields are derived server-side where applicable.

### 3.2 Optional Bearer (`restaurant-users/suggested`)

If `Authorization: Bearer` is present, it must be valid; the handler then excludes the current user from suggestions. If the header is omitted, the route still succeeds with a generic list.

### 3.3 Admin secret (`admin/backfill-rating-summary`)

This route does **not** use a user JWT. It expects:

```http
x-admin-secret: <same value as HASURA_GRAPHQL_ADMIN_SECRET>
```

Treat this like a root credential: only call from trusted jobs or tooling, never from a public client.

---

## 4. Request bodies and methods

- **JSON:** Send `Content-Type: application/json` with a UTF-8 body. Handlers that call `validate()` read **`req.body`** (typical **POST** or **PUT**).
- **Query string:** Many read handlers use `new URL(req.url, …).searchParams`. **GET** is the natural choice.
- **Multipart:** `upload/image` and `upload/batch` expect **multipart/form-data** (file field(s)), not raw JSON.

Nhost forwards the HTTP method to Express. A few handlers branch on **`req.method`** (see §7).

---

## 5. Environment variables (functions runtime)

Functions need secrets available in the Nhost project (Dashboard → **Secrets**) or in local `.secrets` for `nhost dev`. At minimum:

| Variable | Used by |
|----------|---------|
| `HASURA_GRAPHQL_ADMIN_SECRET` | Hasura admin calls; admin route header check |
| `HASURA_GRAPHQL_JWT_SECRET` | `requireAuth` JWT verification |
| `NHOST_SUBDOMAIN`, `NHOST_REGION` | Auto-injected on Nhost cloud; used to derive Hasura GraphQL URL in `_lib/hasura.ts` |
| `HASURA_GRAPHQL_ENDPOINT` | Optional override for Hasura URL |
| `S3_*`, `IMAGE_*` | Upload + image processing |

See [AI_rules.md](./AI_rules.md) and your project `.secrets` template for the full list.

---

## 6. Client implementation guide

### 6.1 Plain `fetch` (browser or server)

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
  const res = await fetch(`${FUNCTIONS_BASE}/${path.replace(/^\//, '')}`, { ...rest, headers })
  return res.json() as Promise<Envelope<T>>
}

// Example: public GET
const r = await tastyplatesFetch<{ categories: unknown[] }>('v1/categories/get-categories')
if (!r.ok) throw new Error(r.error)

// Example: authenticated POST
const r2 = await tastyplatesFetch('v1/restaurant-reviews/create-review', {
  method: 'POST',
  accessToken: session.accessToken,
  body: JSON.stringify({
    restaurant_uuid: '…',
    content: 'Great meal',
    rating: 5,
  }),
})
```

Ensure `FUNCTIONS_BASE` matches your dashboard (include or omit `/v1` consistently with `path`).

### 6.2 Nhost JavaScript client (browser)

After `nhost.auth.signIn…` or session restore:

```typescript
import { nhost } from '@/lib/nhost' // your configured client

const accessToken = nhost.auth.getAccessToken()
const res = await fetch(`${process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL}/v1/restaurant-reviews/get-draft-reviews`, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
})
const json = await res.json()
```

Use the same access token you would send to Hasura with role `user`.

### 6.3 Multipart upload (`upload/image`)

```typescript
const form = new FormData()
form.append('file', fileBlob, 'photo.jpg')

const res = await fetch(`${base}/v1/upload/image`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: form,
})
```

Do not set `Content-Type` manually; the browser sets the multipart boundary.

### 6.4 CORS

Calling these URLs from a **browser** on a different origin than the functions host requires CORS to allow your frontend origin. Nhost/cloud configuration may already allow your app URL; if preflight fails, configure allowed origins in the Nhost project settings. Server-side `fetch` from Next.js route handlers or Node is not subject to CORS.

---

## 7. Special handler behavior

| Route | Notes |
|-------|--------|
| `restaurant-reviews/toggle-like` | **GET** — query params `review_id`, `user_id` (UUIDs); public like check. **POST** — Bearer required; JSON `{ "review_id": "<uuid>" }` toggles like for JWT user. |
| `restaurant-users/toggle-favorite` | **GET** — Bearer; query `restaurant_uuid` **or** `restaurant_slug`; returns `{ status: "saved" \| "unsaved" }`. **POST** — Bearer; JSON body with `restaurant_uuid` and/or `restaurant_slug` (Zod); toggles favorite. |
| `restaurant-users/toggle-checkin` | **GET** — Bearer; same query pattern as toggle-favorite; returns `{ status: "checkedin" \| "uncheckedin" }`. **POST** — Bearer; same body pattern; toggles check-in. |
| `restaurant-reviews/delete-review` | Uses query param `id` (review UUID) plus Bearer; ownership enforced server-side. |
| `restaurant-users/delete-restaurant-user` | Query `hard=true` for hard delete vs soft delete; Bearer required. |
| `restaurants-v2/test-connection` | Returns **403** when `NODE_ENV === 'production'`. |
| `monitoring/graphql-stats` | Returns **403** in production (stub). |
| `restaurant-users/get-restaurant-user-by-firebase-uuid` | Always **410** with `{ ok: false, error: "…" }`; migrate callers to UUID or username routes. |
| `echo` | Auth smoke test only; remove or restrict before production hardening. |

---

## 8. Endpoint catalog

Below, **Path** is the segment to append after `{API_VERSION}/` (e.g. `v1/categories/get-categories` → path `categories/get-categories` if `v1` is already in the base, or full `v1/categories/get-categories` from origin-only base — match your env convention).

Legend: **Auth** — `None` | `Bearer` | `Optional Bearer` | `Admin header`

### 8.1 Core

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `health` | GET | None | Liveness: service name, Node version, uptime |
| `echo` | GET | Bearer | Returns JWT user id and role; debugging only |

### 8.2 Featured & reference data

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `featured-restaurants` | GET | None | Active featured restaurants (with restaurant join when schema allows) |
| `categories/get-categories` | GET | None | List categories; supports `limit`, `offset`, `search`, `parentOnly`, `parentId` |
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
|------|----------------|------|-------------|
| `restaurants-v2/get-restaurants` | GET | None | List/filter restaurants (pagination, filters — see handler for query keys) |
| `restaurants-v2/get-restaurant-by-id` | GET | None | Query `id` and/or `slug` |
| `restaurants-v2/get-rating-summary` | GET | None | Rating summary for one restaurant |
| `restaurants-v2/get-authentic-stats` | GET | None | Authentic stats map |
| `restaurants-v2/get-preference-stats` | GET | None | Palate preference stats |
| `restaurants-v2/match-restaurant` | POST | None | Body: `placeId` and/or `name` + `address` to match existing restaurant |
| `restaurants-v2/test-connection` | GET | None | Dev-only Hasura connectivity check |
| `restaurants-v2/create-restaurant` | POST | Bearer | JSON body: title, slug, optional address/geo/cuisines/etc. |

### 8.4 Reviews — reads (`restaurant-reviews/`)

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `restaurant-reviews/get-all-reviews` | GET | None | Global feed / cursor pagination |
| `restaurant-reviews/get-review-by-id` | GET | None | Single review |
| `restaurant-reviews/get-reviews-by-restaurant` | GET | None | By restaurant |
| `restaurant-reviews/get-user-reviews` | GET | None | By author / user id (query — see handler) |
| `restaurant-reviews/get-following-feed` | GET | None | Feed from followed users |
| `restaurant-reviews/get-replies` | GET | None | Thread replies for a review |
| `restaurant-reviews/get-draft-reviews` | GET | Bearer | Current user’s drafts |

### 8.5 Reviews — writes (`restaurant-reviews/`)

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `restaurant-reviews/create-review` | POST | Bearer | JSON: `restaurant_uuid`, `content`, `rating`, optional `title`, `status`, `images`, `palates`, `hashtags`, `recognitions` |
| `restaurant-reviews/update-review` | POST | Bearer | JSON validated; includes `id` |
| `restaurant-reviews/delete-review` | GET/DELETE | Bearer | Query `id` = review UUID |
| `restaurant-reviews/create-comment` | POST | Bearer | JSON body per Zod schema |
| `restaurant-reviews/toggle-like` | GET / POST | GET: none; POST: Bearer | See §7 |

### 8.6 Users & social (`restaurant-users/`)

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `restaurant-users/create-restaurant-user` | POST | None | Creates profile row (e.g. post-signup). **Securing this in production** should be done via Nhost/Hasura actions or network rules if abuse is a concern |
| `restaurant-users/update-restaurant-user` | POST | Bearer | JSON profile fields; updates JWT user |
| `restaurant-users/delete-restaurant-user` | POST | Bearer | Query `hard=true` optional |
| `restaurant-users/follow` | POST | Bearer | Body `user_id` = user to follow |
| `restaurant-users/unfollow` | POST | Bearer | Body `user_id` |
| `restaurant-users/check-follow-status` | POST | Bearer | Body `user_id` vs JWT follower |
| `restaurant-users/toggle-favorite` | GET / POST | Bearer | See §7 |
| `restaurant-users/toggle-checkin` | GET / POST | Bearer | See §7 |
| `restaurant-users/suggested` | GET | Optional Bearer | Query `limit` |
| `restaurant-users/get-restaurant-users` | GET | None | List/search users |
| `restaurant-users/get-restaurant-user-by-id` | GET | None | By UUID |
| `restaurant-users/get-restaurant-user-by-username` | GET | None | By username |
| `restaurant-users/get-restaurant-user-by-firebase-uuid` | GET | None | Deprecated migration stub |
| `restaurant-users/check-username` | GET | None | Query `username` |
| `restaurant-users/get-followers-list` | GET | None | Query params per handler |
| `restaurant-users/get-following-list` | GET | None | Query params per handler |
| `restaurant-users/get-followers-count` | GET | None | Query params per handler |
| `restaurant-users/get-following-count` | GET | None | Query params per handler |
| `restaurant-users/get-wishlist` | GET | None | Query `user_id` etc. |
| `restaurant-users/get-checkins` | GET | None | User check-ins |
| `restaurant-users/get-reviews` | GET | None | Reviews for a user |

### 8.7 Uploads & images

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `upload/image` | POST | Bearer | Multipart file → Sharp → S3; returns public URL JSON in `data` |
| `upload/batch` | POST | Bearer | Multipart multiple files → S3 |
| `images/download-google-photo` | POST | None | JSON `{ "photoUrl": "<googleapis.com…>" }` → base64 data URL |

### 8.8 Articles

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `articles/get-articles` | GET | None | List with filters/pagination |
| `articles/get-article-by-slug` | GET | None | Query `slug` |
| `articles/get-article-by-id` | GET | None | Query `id` |

### 8.9 Admin & monitoring

| Path | Typical method | Auth | Description |
|------|----------------|------|-------------|
| `admin/backfill-rating-summary` | POST | `x-admin-secret` | Rebuilds rating summaries (long-running; see handler) |
| `monitoring/graphql-stats` | GET | None | Stub; **403** in production |

---

## 9. Testing with `curl`

Replace `BASE` with your real functions URL (including version segment once).

```bash
curl -sS "$BASE/v1/health" | jq .

curl -sS "$BASE/v1/categories/get-categories?limit=5" | jq .

curl -sS -X POST "$BASE/v1/restaurants-v2/match-restaurant" \
  -H "Content-Type: application/json" \
  -d '{"name":"Some Place","address":"123 Main"}' | jq .

curl -sS "$BASE/v1/restaurant-reviews/get-draft-reviews" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

---

## 10. Operational checklist

1. **Dashboard secrets** — All variables referenced in `functions/src/` are set for **production**.
2. **Functions URL** — `NEXT_PUBLIC_NHOST_FUNCTIONS_URL` (or equivalent) matches the dashboard base and path concatenation rules in §1.
3. **Remove or lock down `echo`** before high-traffic production.
4. **Rate limiting** — Not built into all handlers yet; add Redis or edge limits for public POST/GET hot paths before exposing to hostile traffic.
5. **`create-restaurant-user`** — If left public, consider protecting via Nhost webhook / Hasura action / secret header so only your signup pipeline can call it.

---

## 11. Related docs

| Document | Purpose |
|----------|---------|
| [AI_rules.md](./AI_rules.md) | Non-negotiable patterns for function code |
| [decouple-plan.md](./decouple-plan.md) | Phased migration from Next.js `/api/v1` |

When in doubt about query parameter names for a specific route, open the matching file under `functions/src/` — the handler documents the contract in code.

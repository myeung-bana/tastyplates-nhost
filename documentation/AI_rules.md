# AI Rules — `tastyplates-nhost` Functions

Non-negotiable rules for every function written in this project.
These apply to every file under `functions/`, every PR, and every AI-generated suggestion.
If a suggestion violates a rule here, reject it.

---

## 1. Project invariants — never change these casually

- **Runtime:** Node 22. `functions/package.json` `engines.node` and `nhost/nhost.toml` `[functions.node] version = 22` must stay aligned.
- **Compiler target:** `ES2022`.
- **Module output:** `CommonJS` from `tsconfig.json`. TypeScript `import` / `export` syntax is fine; the emitted module format must remain CommonJS.
- **Strict TypeScript:** `"strict": true` stays on. Do not add `// @ts-ignore`, `any`, or loose casts to silence errors.
- **JWT mode:** `HS256` is the current auth mode in `nhost.toml`. Do not switch algorithms without updating both `nhost.toml` and `functions/_lib/auth.ts`.
- **No built output in git:** Nhost bundles on deploy. Never commit `dist/`.
- **Lockfile discipline:** Commit `functions/package-lock.json` with any dependency change so Nhost uses the expected package manager.

---

## 2. Directory layout — route files live at the root

```text
functions/
├── package.json
├── package-lock.json
├── tsconfig.json
├── _lib/
│   ├── env.ts
│   ├── hasura.ts
│   ├── auth.ts
│   ├── respond.ts
│   └── validate.ts
├── health.ts
├── echo.ts
└── <domain>/
    └── <action>.ts
```

**Rules:**
- Route files live under `functions/`, and Nhost maps the full relative file path to the HTTP route.
- Prefix internal-only helpers with `_` so they stay off the public routing surface.
- `_lib/` is for shared infrastructure and helpers only: env resolution, Hasura client helpers, auth, validation, and common response helpers. Do not hide endpoint-specific business logic there.
- Never import one route handler from another route handler.

---

## 3. Route naming — file path is the URL

Examples:

- `health.ts` → `{FUNCTIONS_URL}/v1/health`
- `restaurants-v2/get-restaurants.ts` → `{FUNCTIONS_URL}/v1/restaurants-v2/get-restaurants`
- `restaurant-reviews/create-review.ts` → `{FUNCTIONS_URL}/v1/restaurant-reviews/create-review`

**Rules:**
- Use `kebab-case` for exposed route files and directories.
- One file = one default-exported handler = one route.
- Keep route names close to the existing frontend contract so migrations stay mechanical.

---

## 4. Response envelope — always use `ok()` / `fail()`

All handlers return one of these shapes via `functions/_lib/respond.ts`:

```typescript
{ ok: true, data: <T> }
{ ok: false, error: "<message>", details?: <unknown> }
```

**Rules:**
- Prefer `ok(res, data, status)` and `fail(res, message, status, details)` over hand-written JSON responses.
- Never leak secrets, stack traces, raw Hasura error payloads, or internal env names in the response body.
- Use status codes consistently:
  - `200` success
  - `201` created
  - `400` malformed input
  - `401` unauthenticated
  - `403` authenticated but not allowed
  - `404` resource intentionally hidden or not found
  - `422` validation failed
  - `429` rate limited
  - `500` unexpected server error

---

## 5. Handler structure — keep the flow obvious

Canonical shape:

```typescript
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const body = validate(req, res, InputSchema)
    if (!body) return

    ok(res, { /* result */ })
  } catch (error) {
    console.error('[domain/action]', error)
    fail(res, 'Internal server error', 500)
  }
}
```

**Rules:**
- Handlers must be `export default async` and return `Promise<void>`.
- Wrap handler bodies in `try/catch`.
- Log failures with a searchable `[domain/action]` prefix.
- Preserve the order `auth → validate → business logic → respond` for protected mutations.
- If `requireAuth()` or `validate()` returns `null`, `return` immediately.

---

## 6. Authentication and authorization

Use `requireAuth()` as the only JWT verification entry point.

```typescript
const payload = await requireAuth(req, res)
if (!payload) return
const userId = getUserId(payload)
```

**Rules:**
- Never manually decode `Authorization` tokens inside a handler.
- Never trust `user_id`, `author_id`, `follower_id`, or similar request fields for auth decisions. Derive the acting user from the verified JWT.
- Mutating routes must call `requireAuth()` before touching data.
- Optional-auth routes may inspect whether a Bearer token exists, but if the header is present it must still pass through `requireAuth()`.
- Owner-only reads must compare request params to `getUserId(payload)` and return `403` or hidden `404` as appropriate.
- Admin-only routes must use a dedicated header such as `x-admin-secret` and compare it with `ADMIN_SECRET` from `_lib/env.ts`, not a raw `process.env...` lookup in the handler.

---

## 7. Input validation — Zod on all write paths

```typescript
const body = validate(req, res, InputSchema)
if (!body) return
```

**Rules:**
- Every `POST`, `PUT`, and `PATCH` route validates its JSON body with a named schema at module scope.
- Required query params should be validated explicitly as well; do not let invalid UUIDs or enum-like values fall through to Hasura.
- Keep schemas at module scope so they are readable, reusable, and testable.

---

## 8. Hasura access — use the shared helper

Current server-side Hasura access flows through `functions/_lib/hasura.ts`.

```typescript
const result = await hasuraQuery<MyResult>(MY_QUERY, variables)
if (result.errors?.length) {
  return fail(res, 'Failed to fetch data', 500)
}
```

**Rules:**
- Do not open-code GraphQL `fetch(...)` calls in handlers when `_lib/hasura.ts` already covers the use case.
- GraphQL documents belong at module scope, never inline inside the `fetch` call.
- Always check `result.errors` before using `result.data`.
- Treat Hasura as server-only infrastructure. Never expose admin credentials in logs, responses, or client-facing code.
- If the project later needs a user-scoped Hasura client, add it intentionally in `_lib/` and update this doc at the same time.

---

## 9. Environment variables — `_lib/env.ts` is the source of truth

Nhost secret naming is easy to get wrong. Use the shared env helper instead of sprinkling `process.env` reads across handlers.

| Secret / config source | Runtime variable used in Functions | Notes |
|---|---|---|
| `HASURA_GRAPHQL_ADMIN_SECRET` in Dashboard / `.secrets` | `NHOST_ADMIN_SECRET` | `_lib/env.ts` also falls back to the legacy name |
| `HASURA_GRAPHQL_JWT_SECRET` in Dashboard / `.secrets` | `NHOST_JWT_SECRET` | Nhost wraps this as JSON; parse the `key` for HS256 |
| `HASURA_GRAPHQL_ENDPOINT` override | `NHOST_GRAPHQL_URL` preferred | Use injected GraphQL URL when available |
| `NHOST_SUBDOMAIN`, `NHOST_REGION` | auto-injected | Only used as a final fallback to construct the GraphQL URL |

**Rules:**
- For shared env access, import from `_lib/env.ts`; do not read `process.env.HASURA_GRAPHQL_ADMIN_SECRET` or `process.env.NHOST_JWT_SECRET` directly in route files.
- Do not create a `.env` inside `functions/`. Nhost Functions reads:
  1. system-injected runtime vars,
  2. `[[global.environment]]` values in `nhost.toml`,
  3. secrets from Dashboard / repo-root `.secrets`.
- Local secrets live in the repo-root `.secrets` file, not under `functions/`.
- `.secrets` must stay gitignored and uncommitted.
- Missing required secrets should fail loudly at startup, not degrade silently.

---

## 10. What code should never do

Never reintroduce these patterns:

```typescript
process.env.HASURA_GRAPHQL_ADMIN_SECRET
process.env.HASURA_GRAPHQL_JWT_SECRET
jwt.verify(token, process.env.NHOST_JWT_SECRET!, ...)
fetch(`https://${sub}.graphql.${region}.nhost.run/v1`, ...)
require('dotenv').config()
```

Why they are wrong here:

- The runtime secret names differ from the legacy monolith names.
- `NHOST_JWT_SECRET` arrives as JSON, not a raw secret string.
- `NHOST_GRAPHQL_URL` is the preferred endpoint source.
- `functions/` does not load dotenv files in cloud deploys.

Also do not bring back:

- `NEXT_PUBLIC_*` env access inside Nhost Functions
- Firebase-derived identities for authorization
- caller-trusted `user_id` auth logic
- reliance on `req.invocationId` for correctness

---

## 11. Error handling and logging

- Log unexpected errors with context using `console.error('[domain/action]', error)`.
- Do not rethrow from a top-level handler after catching.
- Do not return raw `error.message` values from unexpected exceptions.
- Handle known conflict / permission / validation cases before the generic catch.

---

## 12. Operational checklist — before every push

- [ ] `npm run build` passes in `functions/`
- [ ] `package-lock.json` is committed with any dependency change
- [ ] No secrets are hardcoded in source
- [ ] New routes follow `auth → validate → logic → respond`
- [ ] Protected routes derive the acting user from `getUserId(payload)`
- [ ] `nhost.toml` still pins Node 22 and HS256 intentionally
- [ ] `.secrets` is not committed
- [ ] After deploy, `GET /v1/health` succeeds before declaring the release healthy
- [ ] After auth-related changes, test one protected route such as `echo` or `restaurant-reviews/get-draft-reviews` with a real Bearer token

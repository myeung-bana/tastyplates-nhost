# AI Rules — `tastyplates-nhost` Functions

Non-negotiable rules for every function written in this project.
These apply to every file under `functions/`, every PR, and every AI-generated suggestion.
If a suggestion violates a rule here, reject it.

---

## 1. Project invariants — never change these

- **Runtime:** Node 22. The `package.json` `engines` field and `nhost.toml` `[functions.node] version = 22` must always agree.
- **Module system:** CommonJS (`"module": "CommonJS"` in `tsconfig.json`). Do not use ESM (`import`/`export`) at the module level in handler files — Nhost's bundler expects CJS.
- **TypeScript target:** `ES2022`. Do not lower this.
- **Strict mode:** `"strict": true` in `tsconfig.json`. Never disable it, never add `// @ts-ignore` or `as any` to work around type errors.
- **JWT algorithm:** `HS256` (symmetric secret from `{{ secrets.HASURA_GRAPHQL_JWT_SECRET }}`). Do not switch to RS256/JWKS without updating `nhost.toml` and the `auth.ts` helper simultaneously.
- **No `dist/` committed.** Nhost bundles on deploy. `dist/` is gitignored; never commit it.

---

## 2. Directory layout — must match exactly

```
functions/
├── package.json
├── package-lock.json        ← commit this; Nhost auto-detects npm from it
├── tsconfig.json
├── _lib/
│   ├── auth.ts              ← JWT verification only
│   ├── respond.ts           ← ok() / fail() only
│   └── validate.ts          ← Zod validation wrapper only
├── health.ts                ← liveness probe; never remove
├── echo.ts                  ← smoke-test; remove before prod
└── <domain>/
    └── <action>.ts          ← one handler per file; see naming rules below
```

**Rules:**
- `_lib/` is for shared utilities **only** — no business logic, no Hasura calls, no HTTP calls.
- Never put handler logic inside `_lib/`. Never import one handler from another.
- Prefix internal-only directories and files with `_` (e.g., `_lib`). These are **not** exposed as HTTP routes by Nhost.

---

## 3. Route naming — file path is the URL

Nhost resolves routes directly from file paths under `functions/`:

| File | HTTP route |
|------|-----------|
| `health.ts` | `{FUNCTIONS_URL}/v1/health` |
| `restaurants-v2/get-restaurants.ts` | `{FUNCTIONS_URL}/v1/restaurants-v2/get-restaurants` |
| `restaurant-reviews/create-review.ts` | `{FUNCTIONS_URL}/v1/restaurant-reviews/create-review` |

**Rules:**
- Use `kebab-case` for all file and directory names — no camelCase, no underscores in routes.
- Segment names become URL path segments. Keep them human-readable and consistent with the existing `/api/v1/` shape so migration is a rename at the frontend, not a redesign.
- One file = one handler = one route. No barrel re-exports for route files.

---

## 4. Response envelope — always use `ok()` / `fail()`

Every handler must return JSON in one of two shapes using the helpers from `_lib/respond.ts`:

```typescript
// Success
{ ok: true, data: <T> }

// Error
{ ok: false, error: "<message>", details?: <unknown> }
```

**Rules:**
- Never call `res.json(...)` directly. Always call `ok(res, data)` or `fail(res, message, status)`.
- Never expose raw Hasura error objects, stack traces, or internal variable names in `error` or `details`.
- HTTP status codes must be semantically correct:
  - `200` — success (default)
  - `201` — resource created
  - `400` — bad request (malformed input not caught by Zod)
  - `401` — unauthenticated
  - `403` — authenticated but not allowed
  - `422` — validation failed (Zod errors — handled automatically by `validate()`)
  - `429` — rate limited
  - `500` — unexpected server error

---

## 5. Authentication — `requireAuth` is the only entry point

```typescript
import { requireAuth, getUserId } from '../_lib/auth'

export default async (req: Request, res: Response): Promise<void> => {
  const payload = await requireAuth(req, res)
  if (!payload) return   // requireAuth already sent 401; stop here
  const userId = getUserId(payload)
  // ...
}
```

**Rules:**
- Never manually decode or inspect `req.headers.authorization`. Always use `requireAuth`.
- Never trust `user_id` or `author_id` from the **request body or query string** for auth decisions. Always derive the acting user from the verified JWT payload via `getUserId(payload)`.
- Routes that are read-only and public (e.g., get-restaurants) may skip `requireAuth`. Every mutating route (create, update, delete, follow, like, upload) **must** call `requireAuth` first.
- `requireAuth` returns `null` and has already sent `401` when it fails. The caller must `return` immediately — never proceed after a `null` payload.

---

## 6. Input validation — Zod on every mutation

```typescript
import { z } from 'zod'
import { validate } from '../_lib/validate'

const MySchema = z.object({
  restaurantId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(2000),
})

const body = validate(req, res, MySchema)
if (!body) return   // validate() already sent 422
```

**Rules:**
- Every `POST`, `PUT`, `PATCH` handler must validate `req.body` with a named Zod schema before touching any data.
- Zod schemas must be defined at module scope (not inside the handler) so they are reusable and inspectable.
- `GET` requests with required query parameters should also validate them — use `z.object({}).parse(req.query)` or `validate()` adapted to `req.query`.
- Never use `any` in a schema. Use `z.unknown()` if the type is genuinely unknown and handle it explicitly.

---

## 7. Handler structure — follow this exact pattern

Every handler must follow this shape:

```typescript
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { validate } from '../_lib/validate'
import { ok, fail } from '../_lib/respond'

const InputSchema = z.object({ /* ... */ })

export default async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Auth (for protected routes)
    const payload = await requireAuth(req, res)
    if (!payload) return
    const userId = getUserId(payload)

    // 2. Validate input
    const body = validate(req, res, InputSchema)
    if (!body) return

    // 3. Business logic (Hasura calls, etc.)

    // 4. Respond
    ok(res, { /* ... */ })
  } catch (error) {
    console.error(`[<domain>/<action>]`, error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
```

**Rules:**
- The export must be `export default` (not named exports). Nhost expects the default export as the handler.
- Handler must be `async` and return `Promise<void>`.
- Always wrap the handler body in `try/catch`. The catch block must `console.error` with a `[domain/action]` prefix so logs are searchable in the Nhost dashboard.
- Catch blocks must **never** call `ok()` — only `fail()` or the raw `res.status(500).json(...)` pattern shown above.
- Order inside the handler: **auth → validate → logic → respond**. Never reorder.

---

## 8. Hasura access — admin secret, server-only

```typescript
const HASURA_ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT!
const HASURA_SECRET   = process.env.HASURA_GRAPHQL_ADMIN_SECRET!

const result = await fetch(HASURA_ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-hasura-admin-secret': HASURA_SECRET,
  },
  body: JSON.stringify({ query: `...`, variables: { ... } }),
})
```

**Rules:**
- All Hasura access uses the **admin secret** — never the user's JWT.
- Never expose `HASURA_GRAPHQL_ADMIN_SECRET` in a response body, log line, or error message.
- Hasura calls must always check `result.errors` from the GraphQL response and call `fail(res, ...)` if present.
- GraphQL query/mutation strings must be defined at module scope (not inline in the fetch call) so they are visible and auditable.
- Never use `NEXT_PUBLIC_*` environment variables. These don't exist in the Nhost Functions runtime.

---

## 9. Environment variables — explicit, never optional in logic

| Variable | Auto-injected | Required for |
|---|---|---|
| `NHOST_SUBDOMAIN` | ✅ by Nhost cloud | JWKS URL (if RS256; not current) |
| `NHOST_REGION` | ✅ by Nhost cloud | JWKS URL (if RS256; not current) |
| `HASURA_GRAPHQL_ADMIN_SECRET` | ❌ set in Dashboard → Secrets | All Hasura calls |
| `HASURA_GRAPHQL_ENDPOINT` | ❌ set in Dashboard → Secrets | All Hasura calls |
| `HASURA_GRAPHQL_JWT_SECRET` | ❌ set in Dashboard → Secrets | JWT verification (HS256) |

**Rules:**
- Access env vars with `process.env.VAR_NAME`. If the value is required, assert it:
  ```typescript
  const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET
  if (!secret) { fail(res, 'Server misconfiguration', 500); return }
  ```
- Never use `process.env.VAR_NAME ?? 'fallback'` for secrets. A missing secret must be a hard failure.
- Never commit `.env` files. The `.gitignore` already excludes them. Set secrets in the Nhost Dashboard or pass them via `nhost dev` `.env` for local.

---

## 10. Error handling — rules for the catch block

- Log with context: `console.error('[domain/action]', error)`.
- Never re-throw inside a handler — catch at the top level and respond.
- Never return stack traces or raw `error.message` from `Error` instances in the response body.
- If a known, expected error needs a specific status code (e.g., 409 Conflict for duplicate username), handle it **before** the generic catch with an explicit `fail(res, ..., 409)` call.
- `console.error` is fine for unexpected errors. `console.warn` for expected degraded-path branches (e.g., missing optional data). `console.log` for local debug only — remove before PR.

---

## 11. Rate limiting (when Upstash Redis is added)

- Rate limits must be checked **after** auth but **before** Hasura calls — fail fast.
- Rate limit failures must respond with `fail(res, 'Too many requests', 429)`.
- Rate limits must **degrade gracefully** — if Redis is unavailable, allow the request through. Never hard-fail the route because Redis is down.
- Sensitive actions requiring rate limits: `create-review`, `create-comment`, `toggle-like`, `follow`, `unfollow`, `toggle-favorite`, `toggle-checkin`, `upload/image`, `upload/batch`.

---

## 12. Uploads (when S3 + Sharp are added)

- Image processing (Sharp) and S3 uploads must live in `upload/` — never inline in a review or restaurant creation handler.
- Never read a file from the filesystem. All file data comes from multipart request body.
- Accepted formats: JPEG, PNG, WebP, AVIF — reject others with `fail(res, 'Unsupported file type', 415)`.
- Sharp optimization is applied server-side before upload: AVIF-first, WebP fallback. Never upload unprocessed originals.
- Never log S3 presigned URLs or upload credentials.

---

## 13. What to treat as outdated / never bring back

- `NEXT_PUBLIC_*` env vars — do not exist in Nhost Functions runtime.
- `firebase_uuid`, Firebase auth patterns — Nhost/Hasura JWT is the only identity source.
- Caller-trusted `user_id` in request body for auth — always derive from verified JWT.
- WordPress API calls or legacy REST endpoints — do not port these.
- `req.invocationId` — this field existed in the Nhost Functions runtime preview but is not guaranteed; do not rely on it in handler logic.

---

## 14. Deployment checklist — before every push

- [ ] `npm run build` passes with **zero** TypeScript errors
- [ ] `package-lock.json` is committed alongside any `package.json` change
- [ ] No secrets or env values are hardcoded in any source file
- [ ] Every new handler follows the `auth → validate → logic → respond` structure
- [ ] Every mutation calls `requireAuth` and derives `userId` from the payload
- [ ] `nhost.toml` `[functions.node] version = 22` is present and unchanged
- [ ] `GET /v1/health` returns `200` after deploy before declaring success

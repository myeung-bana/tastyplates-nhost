# Authorization Issues: Monolith → Nhost Functions

## Root cause in one sentence

In your monolith you set `HASURA_GRAPHQL_ADMIN_SECRET` yourself in `.env`.
In Nhost Functions, the runtime **auto-injects its own system variables under
different names** — and your code must read those instead, or calls will silently
get an undefined secret and fail with 401 / 403.

---

## 1. The variable name mismatch

This is the most common breakage point and is almost never documented clearly.

| Monolith `.env` name | Nhost system variable (auto-injected) | Notes |
|---|---|---|
| `HASURA_GRAPHQL_ADMIN_SECRET` | `NHOST_ADMIN_SECRET` | Same value, different key name |
| `HASURA_GRAPHQL_JWT_SECRET` | `NHOST_JWT_SECRET` | Wrapped as JSON: `{"key":"…","type":"HS256"}` |
| `HASURA_GRAPHQL_ENDPOINT` | `NHOST_GRAPHQL_URL` | Full URL, no need to construct it |
| *(manual)* | `NHOST_SUBDOMAIN` | Auto-injected ✅ |
| *(manual)* | `NHOST_REGION` | Auto-injected ✅ |
| *(manual)* | `NHOST_AUTH_URL` | Auto-injected ✅ |
| *(manual)* | `NHOST_HASURA_URL` | Console URL (not the GraphQL endpoint) |
| *(manual)* | `NHOST_FUNCTIONS_URL` | Auto-injected ✅ |

**The full list Nhost guarantees in every Function runtime:**

```
NHOST_ADMIN_SECRET        ← populated from secrets.HASURA_GRAPHQL_ADMIN_SECRET
NHOST_JWT_SECRET          ← populated from secrets.HASURA_GRAPHQL_JWT_SECRET (as JSON)
NHOST_WEBHOOK_SECRET
NHOST_SUBDOMAIN
NHOST_REGION
NHOST_HASURA_URL          ← Hasura console URL
NHOST_GRAPHQL_URL         ← GraphQL endpoint (use this for queries)
NHOST_AUTH_URL
NHOST_STORAGE_URL
NHOST_FUNCTIONS_URL
```

> **Local dev (`.secrets` file):** Nhost CLI reads a `.secrets` file at the repo root
> and maps those values to the system variables above. You do **not** create a `.env`
> inside `functions/` — secrets flow in via the CLI, not dotenv.

---

## 2. Common failure modes and fixes

### Failure A — Admin secret is `undefined`

**Symptom:** Hasura returns `{ "errors": [{ "message": "x-hasura-admin-secret" }] }`
or a 401 on GraphQL mutations from your Function.

**Cause:** Code reads `process.env.HASURA_GRAPHQL_ADMIN_SECRET` which is `undefined`
in the Nhost runtime.

```typescript
// ❌ Monolith pattern — breaks in Nhost Functions
const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET

// ✅ Nhost Functions pattern
const adminSecret = process.env.NHOST_ADMIN_SECRET
```

---

### Failure B — JWT secret is the raw string, but Nhost wraps it as JSON

**Symptom:** `jwt.verify()` throws "invalid signature" or "secretOrPublicKey must be
an asymmetric key when using RS256" even though the secret looks correct.

**Cause:** `NHOST_JWT_SECRET` is not the raw secret string — it is a JSON object:

```json
{ "key": "your-actual-secret", "type": "HS256" }
```

If you pass the whole JSON string to `jwt.verify()` it will fail.

```typescript
// ❌ Treats the whole JSON blob as the secret
const secret = process.env.NHOST_JWT_SECRET
jwt.verify(token, secret, ...)

// ✅ Parse it first
const jwtConfig = JSON.parse(process.env.NHOST_JWT_SECRET!)
const secret = jwtConfig.key  // the actual signing key
const algorithm = jwtConfig.type  // "HS256" or "RS256"
```

> For **asymmetric (RS256/RS384)** setups — which is the recommended approach in the
> boilerplate's `auth.ts` using JWKS — you never read `NHOST_JWT_SECRET` at all.
> The JWKS endpoint provides the public key automatically. Only parse
> `NHOST_JWT_SECRET` if you are using symmetric HS256.

---

### Failure C — GraphQL endpoint URL is wrong or constructed manually

**Symptom:** `ECONNREFUSED`, `ENOTFOUND`, or Hasura 404 when calling GraphQL from a Function.

**Cause:** Manually constructing the endpoint from subdomain/region, or using a
hardcoded staging URL, instead of using the injected `NHOST_GRAPHQL_URL`.

```typescript
// ❌ Manual construction — fragile, wrong in some regions
const endpoint = `https://${process.env.NHOST_SUBDOMAIN}.graphql.${process.env.NHOST_REGION}.nhost.run/v1`

// ✅ Use the injected variable — always correct for the current environment
const endpoint = process.env.NHOST_GRAPHQL_URL
```

---

### Failure D — Variables are defined in `.env` inside `functions/` and ignored

**Symptom:** Works locally with `node -r dotenv/config` but fails on Nhost cloud deploy.

**Cause:** Nhost Functions does not load `.env` files. The runtime only sees:
1. Nhost system variables (auto-injected)
2. Variables set in `nhost.toml` under `[[global.environment]]`
3. Secrets set in Dashboard → Settings → Secrets

```toml
# nhost/nhost.toml — for non-sensitive config values
[[global.environment]]
name = "MY_THIRD_PARTY_API_URL"
value = "https://api.example.com"
```

Sensitive values (API keys, secrets) must go in Dashboard → **Settings → Secrets**,
not in `nhost.toml` in plain text.

---

### Failure E — `.secrets` file missing locally

**Symptom:** `nhost up` starts but Functions return 401/403 because `NHOST_ADMIN_SECRET`
is empty.

**Cause:** The Nhost CLI looks for a `.secrets` file at the **repo root** (not inside
`functions/`). Without it, system variables that depend on secrets will be empty strings.

```bash
# .secrets (at repo root — add to .gitignore immediately)
HASURA_GRAPHQL_ADMIN_SECRET = 'nhost-admin-secret'
HASURA_GRAPHQL_JWT_SECRET = '0f987876650b4a085e64594fae9219e7781b17506bec02489ad061fba8cb22db'
```

The CLI maps these to `NHOST_ADMIN_SECRET` and `NHOST_JWT_SECRET` automatically.
You do not write `NHOST_ADMIN_SECRET` in `.secrets` — you write the Hasura names
and Nhost re-maps them.

> **Add `.secrets` to `.gitignore` immediately.** Never commit it.

```bash
echo ".secrets" >> .gitignore
```

---

## 3. Corrected `_lib/` files

### `src/_lib/env.ts` — single source of truth for all env vars

Create this file. Every other `_lib` file imports from here rather than calling
`process.env` directly. This makes the mismatch visible in one place and catches
`undefined` at startup rather than at runtime.

```typescript
import process from 'node:process'

function required(key: string): string {
  const value = process.env[key]
  if (!value) {
    // Crash at cold start — far better than a silent 401 mid-request
    throw new Error(
      `Missing required environment variable: ${key}\n` +
      `On Nhost Cloud: set it in Dashboard → Settings → Secrets or nhost.toml.\n` +
      `Locally: add it to .secrets at the repo root.`
    )
  }
  return value
}

// ── Nhost system variables (auto-injected by the runtime) ────────────────────
export const NHOST_ADMIN_SECRET   = required('NHOST_ADMIN_SECRET')
export const NHOST_GRAPHQL_URL    = required('NHOST_GRAPHQL_URL')
export const NHOST_AUTH_URL       = required('NHOST_AUTH_URL')
export const NHOST_SUBDOMAIN      = required('NHOST_SUBDOMAIN')
export const NHOST_REGION         = required('NHOST_REGION')

// ── JWT secret — only needed for HS256 symmetric verification ────────────────
// For RS256/JWKS (recommended), this is not needed in Functions at all.
function parseJwtSecret(): { key: string; type: string } | null {
  const raw = process.env.NHOST_JWT_SECRET
  if (!raw) return null
  try {
    return JSON.parse(raw) as { key: string; type: string }
  } catch {
    throw new Error(
      'NHOST_JWT_SECRET is not valid JSON. ' +
      'Nhost wraps the secret as {"key":"…","type":"HS256"} — do not use the raw string.'
    )
  }
}
export const NHOST_JWT_SECRET = parseJwtSecret()

// ── Your custom secrets (set in Dashboard → Secrets or .secrets locally) ─────
// Add your own here following the same pattern:
// export const UPSTASH_REDIS_REST_URL = required('UPSTASH_REDIS_REST_URL')
// export const AWS_ACCESS_KEY_ID      = required('AWS_ACCESS_KEY_ID')
```

---

### `src/_lib/hasura-client.ts` — corrected Hasura client

Replace any manual `fetch` wrapper that reads `HASURA_GRAPHQL_ADMIN_SECRET`.

```typescript
import { NHOST_ADMIN_SECRET, NHOST_GRAPHQL_URL } from './env'

interface GraphQLRequest {
  query: string
  variables?: Record<string, unknown>
}

interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
}

/**
 * Execute a GraphQL query/mutation with the Hasura admin secret.
 * Use this only for server-side privileged operations — it bypasses all
 * row-level permissions. Always validate the caller's auth before calling this.
 */
export async function hasuraAdmin<T = unknown>(
  request: GraphQLRequest,
): Promise<T> {
  const response = await fetch(NHOST_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // ✅ NHOST_ADMIN_SECRET — not HASURA_GRAPHQL_ADMIN_SECRET
      'x-hasura-admin-secret': NHOST_ADMIN_SECRET,
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    throw new Error(
      `Hasura HTTP error: ${response.status} ${response.statusText} — ` +
      `check NHOST_ADMIN_SECRET is set correctly in your secrets.`
    )
  }

  const result = (await response.json()) as GraphQLResponse<T>

  if (result.errors?.length) {
    const messages = result.errors.map((e) => e.message).join(', ')
    throw new Error(`GraphQL error: ${messages}`)
  }

  if (result.data === undefined) {
    throw new Error('GraphQL response missing data field')
  }

  return result.data
}

/**
 * Execute a GraphQL query forwarding the caller's JWT.
 * This runs with the user's Hasura permissions, not admin.
 * Use this when you want row-level security to apply.
 */
export async function hasuraAsUser<T = unknown>(
  request: GraphQLRequest,
  authorizationHeader: string,
): Promise<T> {
  const response = await fetch(NHOST_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorizationHeader,
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    throw new Error(`Hasura HTTP error: ${response.status} ${response.statusText}`)
  }

  const result = (await response.json()) as GraphQLResponse<T>

  if (result.errors?.length) {
    const messages = result.errors.map((e) => e.message).join(', ')
    throw new Error(`GraphQL error: ${messages}`)
  }

  return result.data as T
}
```

---

### `src/_lib/auth.ts` — corrected JWT verification

The JWKS approach (RS256) does not need `NHOST_JWT_SECRET` at all.
The HS256 fallback now correctly parses the JSON wrapper.

```typescript
import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import { NHOST_SUBDOMAIN, NHOST_REGION, NHOST_JWT_SECRET } from './env'
import { fail } from './respond'

// ── JWKS client for RS256 (recommended) ──────────────────────────────────────
const jwks = jwksClient({
  jwksUri: `https://${NHOST_SUBDOMAIN}.auth.${NHOST_REGION}.nhost.run/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86_400_000,
})

export interface NhostJwtPayload {
  sub: string
  'https://hasura.io/jwt/claims': {
    'x-hasura-user-id': string
    'x-hasura-default-role': string
    'x-hasura-allowed-roles': string[]
  }
  iat: number
  exp: number
}

/**
 * Verify a Bearer JWT from the Authorization header.
 *
 * - Prefers RS256 via JWKS (asymmetric, no secret needed).
 * - Falls back to HS256 if NHOST_JWT_SECRET is set and its type is HS256.
 *
 * Returns the decoded payload, or sends 401 and returns null.
 */
export function requireAuth(
  req: Request,
  res: Response,
): Promise<NhostJwtPayload | null> {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    fail(res, 'Unauthorized: missing or malformed Authorization header', 401)
    return Promise.resolve(null)
  }

  const token = authHeader.split(' ')[1]

  // ── HS256 symmetric path ──────────────────────────────────────────────────
  if (NHOST_JWT_SECRET?.type === 'HS256') {
    return new Promise((resolve) => {
      jwt.verify(
        token,
        NHOST_JWT_SECRET!.key,              // ✅ .key, not the whole JSON string
        { algorithms: ['HS256'] },
        (err, decoded) => {
          if (err) {
            fail(res, `Unauthorized: ${err.message}`, 401)
            resolve(null)
          } else {
            resolve(decoded as NhostJwtPayload)
          }
        },
      )
    })
  }

  // ── RS256 asymmetric path via JWKS (default) ──────────────────────────────
  return new Promise((resolve) => {
    jwt.verify(
      token,
      (header, callback) => {
        jwks.getSigningKey(header.kid, (err, key) => {
          if (err) return callback(err)
          callback(null, key.getPublicKey())
        })
      },
      { algorithms: ['RS256', 'RS384', 'RS512'] },
      (err, decoded) => {
        if (err) {
          fail(res, `Unauthorized: ${err.message}`, 401)
          resolve(null)
        } else {
          resolve(decoded as NhostJwtPayload)
        }
      },
    )
  })
}

export function getUserId(payload: NhostJwtPayload): string {
  return payload['https://hasura.io/jwt/claims']['x-hasura-user-id']
}

export function getUserRole(payload: NhostJwtPayload): string {
  return payload['https://hasura.io/jwt/claims']['x-hasura-default-role']
}
```

---

## 4. What to use in each scenario

| Scenario | Header to send Hasura | Which function to call |
|---|---|---|
| **Admin operation** (bypass all permissions) | `x-hasura-admin-secret: NHOST_ADMIN_SECRET` | `hasuraAdmin()` |
| **User operation** (respect row-level permissions) | `Authorization: Bearer <user-jwt>` | `hasuraAsUser()` |
| **Background job / event trigger** (impersonate a user) | `x-hasura-admin-secret` + `x-hasura-role` + `x-hasura-user-id` | `hasuraAdmin()` with extra headers |

Never mix these up. Sending the admin secret when you should be forwarding the user
JWT means Hasura will bypass your permission rules and return data the user shouldn't see.

---

## 5. Local dev checklist

```
repo root/
├── .secrets          ← HASURA_GRAPHQL_ADMIN_SECRET, HASURA_GRAPHQL_JWT_SECRET
├── .gitignore        ← .secrets must be in here
└── nhost/
    └── nhost.toml    ← [functions.node] version = 22
```

**To verify your secrets are loading locally:**

```bash
# Start the stack
nhost up

# Call the health endpoint and check env is populated
curl https://local.functions.local.nhost.run/v1/health
# Should return 200. If NHOST_ADMIN_SECRET is missing, it will throw at startup.

# Test an admin Hasura call
curl -X POST https://local.functions.local.nhost.run/v1/echo \
  -H "Authorization: Bearer <your-local-jwt>"
```

**To get a local JWT for testing:** sign into your local app (pointed at
`NHOST_SUBDOMAIN=local` / `NHOST_REGION=''`), copy the access token from
the SDK or from the Nhost local dashboard → Auth tab.

---

## 6. Cloud deploy checklist

1. Dashboard → **Settings → Secrets** — confirm both secrets exist:
   - `HASURA_GRAPHQL_ADMIN_SECRET`
   - `HASURA_GRAPHQL_JWT_SECRET`

2. Dashboard → **Settings → Environment Variables** — do **not** add
   `NHOST_ADMIN_SECRET` here manually. Nhost maps the secrets to system
   variables automatically.

3. Any third-party keys (Redis, AWS, Upstash) go in **Secrets**, not
   in `nhost.toml` in plain text.

4. After adding/changing a secret, trigger a redeploy (push a commit, or
   manually redeploy from the Dashboard).

---

## 7. Quick reference — what your code should never do

```typescript
// ❌ Old monolith patterns that break in Nhost Functions

process.env.HASURA_GRAPHQL_ADMIN_SECRET   // undefined — wrong name
process.env.HASURA_GRAPHQL_JWT_SECRET     // undefined — wrong name

// JWT secret as raw string — NHOST_JWT_SECRET is JSON, not a plain string
jwt.verify(token, process.env.NHOST_JWT_SECRET, ...)

// Hardcoded or manually-constructed GraphQL URL
fetch(`https://${sub}.graphql.${region}.nhost.run/v1`, ...)

// Reading a .env file from inside functions/
require('dotenv').config()   // Nhost Functions does not load .env files
```

```typescript
// ✅ Correct Nhost Functions patterns

import { NHOST_ADMIN_SECRET, NHOST_GRAPHQL_URL } from './_lib/env'

// Admin Hasura call
headers: { 'x-hasura-admin-secret': NHOST_ADMIN_SECRET }

// User Hasura call
headers: { 'Authorization': req.headers.authorization }

// GraphQL URL
fetch(NHOST_GRAPHQL_URL, ...)

// JWT secret (HS256 only, after parsing JSON)
const { key, type } = JSON.parse(process.env.NHOST_JWT_SECRET!)
jwt.verify(token, key, { algorithms: [type] }, ...)
```

---

## Reference

| Doc | Link |
|---|---|
| System Environment Variables | https://docs.nhost.io/platform/cloud/environment-variables/ |
| Secrets | https://docs.nhost.io/platform/cloud/secrets/ |
| Using the Nhost SDK (admin session) | https://docs.nhost.io/products/functions/guides/nhost-sdk/ |
| JWT Verification | https://docs.nhost.io/products/functions/guides/jwt-verification/ |
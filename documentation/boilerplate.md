# Nhost Functions — Deployable Boilerplate

A minimal, deploy-ready starting point for Tastyplates' `functions/` module.
Everything here follows the [Nhost Functions Getting Started guide](https://docs.nhost.io/products/functions/guides/getting-started/) and aligns with your existing `tech-stack.md` layout.

---

## Directory Structure

```
functions/
├── package.json               # Node 22, dependencies, scripts
├── tsconfig.json              # Strict TS, path aliases
├── _lib/
│   ├── auth.ts                # JWT verification helper
│   ├── respond.ts             # Typed response envelope helpers
│   └── validate.ts            # Zod request validation wrapper
├── health.ts                  # GET /health — liveness probe
└── echo.ts                    # GET /echo  — smoke test (remove in prod)
```

> **How Nhost resolves routes:** a file at `reviews/create.ts` is callable at
> `{FUNCTIONS_URL}/v1/reviews/create`. Route files live directly under `functions/`;
> subdirectories become path segments, while underscored paths like `_lib/` stay internal.

---

## 1. `package.json`

```json
{
  "name": "tastyplates-functions",
  "version": "0.1.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit --watch"
  },
  "dependencies": {
    "jsonwebtoken": "^9.0.2",
    "jwks-rsa": "^3.1.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

> **Package manager:** Add a `package-lock.json` (npm), `yarn.lock` (yarn), or
> `pnpm-lock.yaml` (pnpm) to the `functions/` folder. Nhost auto-detects which
> manager to use based on whichever lockfile is present — if multiple exist, the
> preference order is npm → pnpm → yarn.

---

## 2. `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "paths": {
      "@lib/*": ["_lib/*"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

> `tsc --noEmit` is used for typechecking only — Nhost handles bundling on deploy,
> so you never need to commit a `dist/` folder.

---

## 3. `nhost/nhost.toml` — Functions block

Add or confirm this block exists in your `nhost.toml`:

```toml
[functions.node]
version = 22
```

This pins the cloud runtime to Node 22, matching your `engines` field above.

---

## 4. Shared library — `_lib/`

### `_lib/respond.ts`

Typed response helpers that enforce a consistent envelope across every function.

```typescript
import type { Response } from 'express'

/** Standard success envelope */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data })
}

/** Standard error envelope */
export function fail(
  res: Response,
  message: string,
  status = 400,
  details?: unknown,
): void {
  res.status(status).json({ ok: false, error: message, ...(details ? { details } : {}) })
}
```

### `_lib/validate.ts`

Zod validation wrapper — call this at the top of any handler that accepts a request body.

```typescript
import type { Request, Response } from 'express'
import { ZodSchema, ZodError } from 'zod'
import { fail } from './respond'

/**
 * Validates req.body against a Zod schema.
 * Returns the typed data on success, sends a 422 and returns null on failure.
 *
 * Usage:
 *   const body = validate(req, res, MySchema)
 *   if (!body) return
 */
export function validate<T>(
  req: Request,
  res: Response,
  schema: ZodSchema<T>,
): T | null {
  const result = schema.safeParse(req.body)
  if (!result.success) {
    const issues = (result.error as ZodError).issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }))
    fail(res, 'Validation failed', 422, issues)
    return null
  }
  return result.data
}
```

### `_lib/auth.ts`

JWT verification using the Nhost JWKS endpoint (asymmetric / RS256).
Uses `jwks-rsa` with a 24-hour public key cache to avoid hammering the auth service.

```typescript
import type { Request, Response } from 'express'
import process from 'node:process'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import { fail } from './respond'

const subdomain = process.env.NHOST_SUBDOMAIN
const region = process.env.NHOST_REGION

const client = jwksClient({
  jwksUri: `https://${subdomain}.auth.${region}.nhost.run/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86_400_000, // 24 hours
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
 * Extracts and verifies the Bearer JWT from the Authorization header.
 * Sends 401 and returns null on any failure — callers just `if (!payload) return`.
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

  return new Promise((resolve) => {
    jwt.verify(
      token,
      (header, callback) => {
        client.getSigningKey(header.kid, (err, key) => {
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

/** Pull the Hasura user ID out of a verified payload — convenience shorthand. */
export function getUserId(payload: NhostJwtPayload): string {
  return payload['https://hasura.io/jwt/claims']['x-hasura-user-id']
}
```

> **Symmetric key alternative:** If your project uses HS256 instead of RS256, replace
> the `jwksClient` setup with
> `jwt.verify(token, process.env.HASURA_GRAPHQL_JWT_SECRET, { algorithms: ['HS256'] }, ...)`.
> Check your `nhost.toml` or dashboard under **Auth → JWT** to confirm which you use.

---

## 5. Function handlers

### `health.ts`

The liveness probe — deploy this first and verify it returns 200 before writing any other logic.

```typescript
import type { Request, Response } from 'express'
import process from 'node:process'
import { ok } from './_lib/respond'

export default (_req: Request, res: Response): void => {
  ok(res, {
    status: 'ok',
    service: 'tastyplates-functions',
    node: process.version,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  })
}
```

**Endpoint:** `GET {FUNCTIONS_URL}/v1/health`

**Expected response:**
```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "service": "tastyplates-functions",
    "node": "v22.x.x",
    "uptime": 42,
    "timestamp": "2026-05-10T00:00:00.000Z"
  }
}
```

---

### `echo.ts`

A smoke-test endpoint useful during initial deployment to confirm routing, headers, and JWT flow work end-to-end. **Remove or gate behind an env flag before going to production.**

```typescript
import type { Request, Response } from 'express'
import process from 'node:process'
import { requireAuth } from './_lib/auth'
import { ok } from './_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return // requireAuth already sent 401

    ok(res, {
      message: 'Echo OK',
      invocationId: req.invocationId,
      query: req.query,
      headers: req.headers,
      user: {
        id: payload['https://hasura.io/jwt/claims']['x-hasura-user-id'],
        role: payload['https://hasura.io/jwt/claims']['x-hasura-default-role'],
      },
      node: process.version,
      arch: process.arch,
    })
  } catch (error) {
    console.error(`[echo] invocationId=${req.invocationId}`, error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
```

**Endpoint:** `GET {FUNCTIONS_URL}/v1/echo`

---

## 6. Environment variables

These must be set in your Nhost Dashboard under **Settings → Secrets** (cloud) or your local `.env` file when running `nhost dev`.

| Variable | Where it comes from | Required |
|---|---|---|
| `NHOST_SUBDOMAIN` | Auto-injected by Nhost cloud | ✅ |
| `NHOST_REGION` | Auto-injected by Nhost cloud | ✅ |
| `HASURA_GRAPHQL_ADMIN_SECRET` | Dashboard → Settings → Secrets | ✅ |
| `HASURA_GRAPHQL_ENDPOINT` | e.g. `https://<sub>.hasura.<region>.nhost.run/v1/graphql` | ✅ |
| `HASURA_GRAPHQL_JWT_SECRET` | Only needed if using HS256 symmetric JWT | ⚠️ |

> `NHOST_SUBDOMAIN` and `NHOST_REGION` are automatically available in the Nhost
> Functions runtime — you do not need to set them manually in the dashboard.

---

## 7. Deployment checklist

Run through this before your first git push:

- [ ] `npm install` inside `functions/` — confirm `node_modules` is populated
- [ ] `npm run build` (typecheck) passes with zero errors
- [ ] `nhost.toml` has `[functions.node] version = 22`
- [ ] Lockfile (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`) is committed
- [ ] `HASURA_GRAPHQL_ADMIN_SECRET` is set in the Nhost Dashboard secrets
- [ ] Push to the GitHub branch connected to your Nhost project
- [ ] Watch the Deployment tab in the Nhost Dashboard — Functions logs appear there
- [ ] `curl {FUNCTIONS_URL}/v1/health` returns `200 { "ok": true, ... }`
- [ ] `curl -H "Authorization: Bearer <token>" {FUNCTIONS_URL}/v1/echo` returns your user ID

---

## 8. Local development

```bash
# From the repo root (requires Nhost CLI + Docker)
nhost up

# Functions are then available at:
# https://local.functions.local.nhost.run/v1/<path>
```

Test the health endpoint locally:
```bash
curl https://local.functions.local.nhost.run/v1/health
```

Test the echo endpoint locally with a JWT from your local auth:
```bash
curl -H "Authorization: Bearer <your-local-jwt>" \
  https://local.functions.local.nhost.run/v1/echo
```

---

## 9. Adding your first real function

Once `health` deploys successfully, follow this pattern for every new handler:

```typescript
// reviews/create.ts
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { validate } from '../_lib/validate'
import { ok, fail } from '../_lib/respond'

const CreateReviewSchema = z.object({
  restaurantId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  body: z.string().min(1).max(2000),
})

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const body = validate(req, res, CreateReviewSchema)
    if (!body) return

    const userId = getUserId(payload)

    // TODO: your Hasura mutation / business logic here

    ok(res, { message: 'created', userId }, 201)
  } catch (error) {
    console.error(`[reviews/create] invocationId=${req.invocationId}`, error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
```

**Route auto-resolves to:** `POST {FUNCTIONS_URL}/v1/reviews/create`

---

## Reference

| Doc | Link |
|---|---|
| Functions Getting Started | https://docs.nhost.io/products/functions/guides/getting-started/ |
| JWT Verification | https://docs.nhost.io/products/functions/guides/jwt-verification/ |
| Error Handling | https://docs.nhost.io/products/functions/guides/error-handling/ |
| Runtimes & Dependencies | https://docs.nhost.io/products/functions/runtimes/ |
| Nhost CLI local dev | https://docs.nhost.io/platform/cli/local-development |
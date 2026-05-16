import type { Algorithm } from 'jsonwebtoken'
import process from 'node:process'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (v == null || v === '') {
    throw new Error(`${name} is not set`)
  }
  return v
}

/** Nhost Functions runtime (mapped from Dashboard / `.secrets` `HASURA_GRAPHQL_ADMIN_SECRET`). */
export const NHOST_ADMIN_SECRET = requiredEnv('NHOST_ADMIN_SECRET')

/** Hasura GraphQL endpoint injected by Nhost Functions. */
export const NHOST_GRAPHQL_URL = requiredEnv('NHOST_GRAPHQL_URL')

/** Nhost Auth HTTP API root (JWT user admin operations, etc.). */
export const NHOST_AUTH_URL = requiredEnv('NHOST_AUTH_URL').replace(/\/$/, '')

export const NHOST_SUBDOMAIN = requiredEnv('NHOST_SUBDOMAIN')

export const NHOST_REGION = requiredEnv('NHOST_REGION')

/** Back-compat names used by handlers; prefer `NHOST_*` above per documentation/correction.md. */
export const ADMIN_SECRET = NHOST_ADMIN_SECRET
export const GRAPHQL_URL = NHOST_GRAPHQL_URL

export interface JwtVerifyOptions {
  secret: string
  algorithms: Algorithm[]
}

/**
 * Bearer JWT verification options. `NHOST_JWT_SECRET` is JSON `{"key":"…","type":"HS256"}`
 * in Nhost Functions; `.secrets` / legacy may use plain `HASURA_GRAPHQL_JWT_SECRET`.
 *
 * Mirrors documentation/correction.md Fix 7 — do not pass the raw JSON wrapper as verify secret.
 */
export function resolveJwtVerifyOptions(): JwtVerifyOptions | null {
  const wrapped = process.env.NHOST_JWT_SECRET
  if (wrapped) {
    let jwtConfig: { key?: string; type?: string }
    try {
      jwtConfig = JSON.parse(wrapped) as { key?: string; type?: string }
    } catch {
      throw new Error(
        'NHOST_JWT_SECRET is not valid JSON. Nhost exposes {"key":"…","type":"HS256"}.',
      )
    }
    if (!jwtConfig.key) {
      throw new Error('NHOST_JWT_SECRET JSON missing "key"')
    }
    const type = (jwtConfig.type ?? 'HS256') as Algorithm
    return {
      secret: jwtConfig.key,
      algorithms: [type],
    }
  }
  const legacy = process.env.HASURA_GRAPHQL_JWT_SECRET
  return legacy != null && legacy !== ''
    ? { secret: legacy, algorithms: ['HS256'] }
    : null
}

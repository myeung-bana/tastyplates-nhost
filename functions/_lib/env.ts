import process from 'node:process'

/** First non-empty string among env-style values. */
function firstSet(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (v != null && v !== '') return v
  }
  return undefined
}

/**
 * Nhost Functions inject `NHOST_ADMIN_SECRET` from Dashboard / `.secrets` `HASURA_GRAPHQL_ADMIN_SECRET`.
 * Fall back to the legacy monolith-style name when running outside Nhost's mapping.
 */
function resolveAdminSecret(): string {
  const v = firstSet(process.env.NHOST_ADMIN_SECRET, process.env.HASURA_GRAPHQL_ADMIN_SECRET)
  if (!v) {
    throw new Error(
      'Missing Hasura admin secret. Set Dashboard / .secrets HASURA_GRAPHQL_ADMIN_SECRET ' +
      '(runtime: NHOST_ADMIN_SECRET) — see documentation/nhost-guide.md.',
    )
  }
  return v
}

/**
 * Prefer injected `NHOST_GRAPHQL_URL`, then explicit override, then subdomain/region.
 */
function resolveGraphqlUrl(): string {
  const injected = firstSet(
    process.env.NHOST_GRAPHQL_URL,
    process.env.HASURA_GRAPHQL_ENDPOINT,
  )
  if (injected) return injected
  const sub = process.env.NHOST_SUBDOMAIN
  const region = process.env.NHOST_REGION
  if (sub && region) return `https://${sub}.hasura.${region}.nhost.run/v1/graphql`
  throw new Error(
    'Hasura GraphQL URL could not be resolved. Set NHOST_GRAPHQL_URL / HASURA_GRAPHQL_ENDPOINT ' +
    'or NHOST_SUBDOMAIN + NHOST_REGION — see documentation/nhost-guide.md.',
  )
}

/** Cold-start fail on misconfiguration when using Hasura from Functions */
export const ADMIN_SECRET = resolveAdminSecret()
export const GRAPHQL_URL = resolveGraphqlUrl()

/** Alias used by auth admin delete and docs. */
export const NHOST_ADMIN_SECRET = ADMIN_SECRET
export const NHOST_GRAPHQL_URL = GRAPHQL_URL

function resolveAuthUrl(): string {
  const injected = firstSet(process.env.NHOST_AUTH_URL, process.env.NHOST_BACKEND_URL)
  if (injected) return injected.replace(/\/$/, '')
  const sub = process.env.NHOST_SUBDOMAIN
  const region = process.env.NHOST_REGION
  if (sub && region) return `https://${sub}.auth.${region}.nhost.run`
  throw new Error(
    'Nhost Auth URL could not be resolved. Set NHOST_AUTH_URL or NHOST_SUBDOMAIN + NHOST_REGION.',
  )
}

export const NHOST_AUTH_URL = resolveAuthUrl()

/**
 * HS256 signing key for `jwt.verify`. Cloud exposes JSON in `NHOST_JWT_SECRET`;
 * raw `HASURA_GRAPHQL_JWT_SECRET` still works locally / legacy setups.
 */
export function resolveJwtSigningKeyHs256(): string | null {
  const wrapped = process.env.NHOST_JWT_SECRET
  if (wrapped) {
    try {
      const parsed = JSON.parse(wrapped) as { key?: string; type?: string }
      if (!parsed.key) {
        throw new Error('NHOST_JWT_SECRET JSON missing "key"')
      }
      if (parsed.type && parsed.type !== 'HS256') {
        throw new Error(
          `NHOST_JWT_SECRET type is "${parsed.type}" — expected HS256. Update nhost.toml / auth verification if using RS256.`,
        )
      }
      return parsed.key
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(
          'NHOST_JWT_SECRET is not valid JSON. Nhost exposes {"key":"…","type":"HS256"}.',
        )
      }
      throw e
    }
  }
  const legacy = process.env.HASURA_GRAPHQL_JWT_SECRET
  return legacy && legacy !== '' ? legacy : null
}

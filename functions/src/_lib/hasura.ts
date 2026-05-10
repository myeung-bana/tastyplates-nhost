import process from 'node:process'

// Prefer an explicit override; otherwise derive from Nhost auto-injected vars.
// NHOST_SUBDOMAIN and NHOST_REGION are always present in the Nhost Functions runtime.
function resolveEndpoint(): string {
  if (process.env.HASURA_GRAPHQL_ENDPOINT) return process.env.HASURA_GRAPHQL_ENDPOINT
  const sub    = process.env.NHOST_SUBDOMAIN
  const region = process.env.NHOST_REGION
  if (sub && region) return `https://${sub}.hasura.${region}.nhost.run/v1/graphql`
  throw new Error(
    'Hasura endpoint could not be resolved. ' +
    'Set HASURA_GRAPHQL_ENDPOINT or ensure NHOST_SUBDOMAIN and NHOST_REGION are available.'
  )
}

const ENDPOINT = resolveEndpoint()
const SECRET   = process.env.HASURA_GRAPHQL_ADMIN_SECRET!

export async function hasuraQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: Array<{ message: string }> }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': SECRET,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json() as Promise<{ data: T | null; errors?: Array<{ message: string }> }>
}

export const hasuraMutation = hasuraQuery

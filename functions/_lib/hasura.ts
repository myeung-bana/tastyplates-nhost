import { ADMIN_SECRET, GRAPHQL_URL } from './env'

export async function hasuraQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: Array<{ message: string }> }> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json() as Promise<{ data: T | null; errors?: Array<{ message: string }> }>
}

export const hasuraMutation = hasuraQuery

/** Admin-secret GraphQL access. */
export const hasuraAdmin = hasuraQuery

/** User-scoped GraphQL with JWT (for RLS). Use when admin bypass is not appropriate. */
export async function hasuraAsUser<T = Record<string, unknown>>(
  jwt: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: Array<{ message: string }> }> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json() as Promise<{ data: T | null; errors?: Array<{ message: string }> }>
}

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

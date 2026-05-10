import process from 'node:process'

const ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT!
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

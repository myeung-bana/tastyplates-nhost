import { NHOST_ADMIN_SECRET, NHOST_GRAPHQL_URL } from './env'

/**
 * Admin-secret GraphQL: throws on HTTP errors or GraphQL `errors`.
 * Naming and env usage per documentation/correction.md Fix 2 & Fix 8.
 */
export async function hasuraAdmin<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(NHOST_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': NHOST_ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`Hasura HTTP error: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(', '))
  }

  return json.data as T
}

/** Named alias — explicit export per documentation/correction.md Fix 8. */
export { hasuraAdmin as hasuraMutation }

/** Back-compat: callers that inspect `.errors` without try/catch. */
export async function hasuraQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: Array<{ message: string }> }> {
  try {
    const data = await hasuraAdmin<T>(query, variables)
    return { data }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { data: null, errors: [{ message }] }
  }
}

/** User-scoped GraphQL with JWT (RLS path). Admin bypass not used here. */
export async function hasuraAsUser<T = Record<string, unknown>>(
  jwt: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: Array<{ message: string }> }> {
  const res = await fetch(NHOST_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json() as Promise<{ data: T | null; errors?: Array<{ message: string }> }>
}

import { NHOST_ADMIN_SECRET, NHOST_GRAPHQL_URL } from './env'

export class HasuraSqlError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'HasuraSqlError'
  }
}

function getHasuraQueryUrl(): string {
  return NHOST_GRAPHQL_URL.replace(/\/v1\/graphql\/?$/, '/v2/query')
}

function rowsToObjects<T extends Record<string, unknown>>(result: unknown): T[] {
  if (!Array.isArray(result) || result.length === 0) return []
  const [header, ...rows] = result as [string[], ...unknown[][]]
  if (!Array.isArray(header)) return []
  return rows.map((row) => {
    const obj: Record<string, unknown> = {}
    header.forEach((col, index) => {
      obj[col] = (row as unknown[])[index]
    })
    return obj as T
  })
}

export async function hasuraRunSql<T extends Record<string, unknown>>(
  sql: string,
  options?: { readOnly?: boolean },
): Promise<T[]> {
  const response = await fetch(getHasuraQueryUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': NHOST_ADMIN_SECRET,
    },
    body: JSON.stringify({
      type: 'run_sql',
      args: {
        sql,
        cascade: false,
        read_only: options?.readOnly ?? false,
      },
    }),
  })

  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    message?: string
    internal?: { error?: { message?: string } }
    result_type?: string
    result?: unknown
  }

  if (!response.ok) {
    const message =
      body.internal?.error?.message ||
      body.message ||
      body.error ||
      `Hasura SQL request failed (${response.status})`
    throw new HasuraSqlError(message, body)
  }

  if (body.error || body.message) {
    throw new HasuraSqlError(body.message || body.error || 'Hasura SQL failed', body)
  }

  if (body.result_type === 'TuplesOk') return rowsToObjects<T>(body.result)
  if (body.result_type === 'CommandOk') return []
  return rowsToObjects<T>(body.result)
}

export function assertUuid(value: string, fieldName: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HasuraSqlError(`Invalid ${fieldName}`)
  }
  return value
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

export function toSqlTextArray(values: string[]): string {
  const items = values.map((v) => `'${escapeSqlLiteral(v)}'`)
  return `ARRAY[${items.join(', ')}]::text[]`
}

export function isMissingMcpTableError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)
  return (
    message.includes('admin_mcp_api_keys') &&
    (message.includes('does not exist') || message.includes('relation'))
  )
}

export const MCP_TABLE_SETUP_HINT =
  'Run tastyplates-nhost/documentation/migrations/add_admin_mcp_api_keys.sql in Nhost SQL Editor.'

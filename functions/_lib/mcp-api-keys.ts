import { createHash, randomBytes } from 'node:crypto'

import {
  assertUuid,
  escapeSqlLiteral,
  hasuraRunSql,
  isMissingMcpTableError,
  MCP_TABLE_SETUP_HINT,
  toSqlTextArray,
} from './hasura-run-sql'

export const MCP_KEY_PREFIX = 'tp_mcp_'
export const MAX_ACTIVE_KEYS_PER_ADMIN = 5

export interface McpApiKeyRecord {
  id: string
  admin_user_id: string
  name: string
  key_prefix: string
  scopes: string[]
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface McpApiKeyAuthRecord extends McpApiKeyRecord {
  key_hash: string
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\{|\}$/g, '')
    if (!trimmed) return []
    return trimmed.split(',').map((s) => s.replace(/^"|"$/g, ''))
  }
  return ['*']
}

function mapKeyRow(row: Record<string, unknown>): McpApiKeyRecord {
  return {
    id: String(row.id),
    admin_user_id: String(row.admin_user_id),
    name: String(row.name),
    key_prefix: String(row.key_prefix),
    scopes: parseScopes(row.scopes),
    last_used_at: row.last_used_at ? String(row.last_used_at) : null,
    expires_at: row.expires_at ? String(row.expires_at) : null,
    revoked_at: row.revoked_at ? String(row.revoked_at) : null,
    created_at: String(row.created_at),
  }
}

function mapAuthRow(row: Record<string, unknown>): McpApiKeyAuthRecord {
  return { ...mapKeyRow(row), key_hash: String(row.key_hash) }
}

function wrapDbError(error: unknown): Error {
  if (isMissingMcpTableError(error)) return new Error(MCP_TABLE_SETUP_HINT)
  if (error instanceof Error) return error
  return new Error('Database operation failed')
}

export function hashMcpApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString('hex')
}

export function generateMcpApiKey(): {
  rawKey: string
  keyPrefix: string
  keyHash: string
} {
  const random = randomHex(24)
  const rawKey = `${MCP_KEY_PREFIX}${random}`
  return {
    rawKey,
    keyPrefix: rawKey.slice(0, 12),
    keyHash: hashMcpApiKey(rawKey),
  }
}

export function isMcpApiKeyFormat(token: string): boolean {
  return token.startsWith(MCP_KEY_PREFIX) && token.length > MCP_KEY_PREFIX.length + 16
}

export async function listMcpApiKeys(adminUserId: string): Promise<McpApiKeyRecord[]> {
  const userId = assertUuid(adminUserId, 'admin_user_id')
  try {
    const rows = await hasuraRunSql<Record<string, unknown>>(
      `SELECT id, admin_user_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
       FROM public.admin_mcp_api_keys
       WHERE admin_user_id = '${userId}'::uuid AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      { readOnly: true },
    )
    return rows.map(mapKeyRow)
  } catch (error) {
    throw wrapDbError(error)
  }
}

export async function countActiveMcpKeys(adminUserId: string): Promise<number> {
  const userId = assertUuid(adminUserId, 'admin_user_id')
  try {
    const rows = await hasuraRunSql<Record<string, unknown>>(
      `SELECT COUNT(*)::int AS count FROM public.admin_mcp_api_keys
       WHERE admin_user_id = '${userId}'::uuid AND revoked_at IS NULL`,
      { readOnly: true },
    )
    return Number(rows[0]?.count ?? 0)
  } catch (error) {
    throw wrapDbError(error)
  }
}

export async function lookupMcpApiKey(rawKey: string): Promise<McpApiKeyAuthRecord | null> {
  const keyHash = hashMcpApiKey(rawKey)
  if (!/^[0-9a-f]{64}$/i.test(keyHash)) return null

  try {
    const rows = await hasuraRunSql<Record<string, unknown>>(
      `SELECT id, admin_user_id, name, key_prefix, key_hash, scopes, last_used_at, expires_at, revoked_at, created_at
       FROM public.admin_mcp_api_keys
       WHERE key_hash = '${keyHash}' AND revoked_at IS NULL LIMIT 1`,
      { readOnly: true },
    )
    const row = rows[0]
    if (!row) return null
    const mapped = mapAuthRow(row)
    if (mapped.expires_at && new Date(mapped.expires_at) < new Date()) return null
    return mapped
  } catch (error) {
    console.error('[mcp-api-keys] lookup error', error)
    return null
  }
}

export async function touchMcpApiKey(id: string): Promise<void> {
  const keyId = assertUuid(id, 'key id')
  try {
    await hasuraRunSql(
      `UPDATE public.admin_mcp_api_keys SET last_used_at = now() WHERE id = '${keyId}'::uuid`,
    )
  } catch (error) {
    console.warn('[mcp-api-keys] touch failed', error)
  }
}

export async function createMcpApiKey(
  adminUserId: string,
  name: string,
  scopes: string[] = ['*'],
): Promise<{ record: McpApiKeyRecord; rawKey: string }> {
  const userId = assertUuid(adminUserId, 'admin_user_id')
  const activeCount = await countActiveMcpKeys(userId)
  if (activeCount >= MAX_ACTIVE_KEYS_PER_ADMIN) {
    throw new Error(`Maximum of ${MAX_ACTIVE_KEYS_PER_ADMIN} active keys allowed`)
  }

  const { rawKey, keyPrefix, keyHash } = generateMcpApiKey()
  const safeName = escapeSqlLiteral(name.trim() || 'Default')
  const safeScopes = scopes.length ? scopes : ['*']

  try {
    const rows = await hasuraRunSql<Record<string, unknown>>(
      `INSERT INTO public.admin_mcp_api_keys (admin_user_id, name, key_prefix, key_hash, scopes)
       VALUES ('${userId}'::uuid, '${safeName}', '${escapeSqlLiteral(keyPrefix)}', '${keyHash}', ${toSqlTextArray(safeScopes)})
       RETURNING id, admin_user_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at`,
    )
    const row = rows[0]
    if (!row) throw new Error('Failed to create MCP key')
    return { record: mapKeyRow(row), rawKey }
  } catch (error) {
    throw wrapDbError(error)
  }
}

export async function revokeMcpApiKey(adminUserId: string, keyId: string): Promise<boolean> {
  const userId = assertUuid(adminUserId, 'admin_user_id')
  const id = assertUuid(keyId, 'key id')
  try {
    const rows = await hasuraRunSql<Record<string, unknown>>(
      `UPDATE public.admin_mcp_api_keys SET revoked_at = now()
       WHERE id = '${id}'::uuid AND admin_user_id = '${userId}'::uuid AND revoked_at IS NULL
       RETURNING id`,
    )
    return rows.length > 0
  } catch (error) {
    throw wrapDbError(error)
  }
}

export function getUserIdFromJwtPayload(payload: Record<string, unknown>): string {
  const claims = payload['https://hasura.io/jwt/claims'] as Record<string, unknown> | undefined
  return (claims?.['x-hasura-user-id'] as string) ?? (payload.sub as string) ?? ''
}

import {
  createMcpApiKey,
  listMcpApiKeys,
  MAX_ACTIVE_KEYS_PER_ADMIN,
  revokeMcpApiKey,
} from './mcp-api-keys'
import {
  buildClaudeCodeCommand,
  buildClaudeDesktopConfig,
  buildCursorMcpConfig,
  buildLocalDevConfig,
  getAdminApiUrl,
  MCP_PACKAGE_NAME,
  MCP_TOOLS,
} from './admin-mcp-config'

export async function listMcpKeys(userId: string) {
  const keys = await listMcpApiKeys(userId)
  return {
    success: true as const,
    data: keys,
    meta: {
      max_active_keys: MAX_ACTIVE_KEYS_PER_ADMIN,
      active_count: keys.length,
    },
  }
}

export async function createMcpKey(userId: string, body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name : 'Default'
  const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : ['*']
  const { record, rawKey } = await createMcpApiKey(userId, name, scopes)
  return {
    success: true as const,
    data: { ...record, api_key: rawKey },
    warning: 'Copy this API key now. It will not be shown again.',
  }
}

export async function revokeMcpKey(userId: string, keyId: string) {
  const revoked = await revokeMcpApiKey(userId, keyId)
  if (!revoked) return null
  return { success: true as const }
}

export function getMcpConfig() {
  const placeholderKey = '<your-generated-api-key>'
  return {
    success: true as const,
    data: {
      api_url: getAdminApiUrl(),
      package_name: MCP_PACKAGE_NAME,
      tools: MCP_TOOLS,
      max_active_keys: MAX_ACTIVE_KEYS_PER_ADMIN,
      config: {
        claude_desktop: buildClaudeDesktopConfig(placeholderKey),
        claude_code: buildClaudeCodeCommand(placeholderKey),
        cursor: buildCursorMcpConfig(placeholderKey),
        local_dev: buildLocalDevConfig(placeholderKey),
      },
    },
  }
}

export function getMcpHealth() {
  return {
    success: true as const,
    data: {
      status: 'ok',
      api_url: getAdminApiUrl(),
      package_name: MCP_PACKAGE_NAME,
      tool_count: MCP_TOOLS.length,
      timestamp: new Date().toISOString(),
    },
  }
}

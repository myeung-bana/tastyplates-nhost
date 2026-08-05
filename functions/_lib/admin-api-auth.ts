import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import process from 'node:process'

import type { NhostJwtPayload } from './auth'
import { adminError } from './admin-api-respond'
import { ADMIN_SECRET, resolveJwtVerifyOptions } from './env'
import {
  getUserIdFromJwtPayload,
  isMcpApiKeyFormat,
  lookupMcpApiKey,
  touchMcpApiKey,
} from './mcp-api-keys'

export type AdminApiAuthType = 'mcp' | 'session'

export interface AdminApiAuthContext {
  type: AdminApiAuthType
  userId: string
  scopes: string[]
  mcpKeyId?: string
}

const JWT_VERIFY = resolveJwtVerifyOptions()

export function hasAdminRole(payload: Record<string, unknown>): boolean {
  const claims = payload['https://hasura.io/jwt/claims'] as Record<string, unknown> | undefined
  const roles = claims?.['x-hasura-allowed-roles']
  return Array.isArray(roles) && roles.includes('admin')
}

async function verifyNhostAdminJwt(token: string): Promise<AdminApiAuthContext | null> {
  if (!JWT_VERIFY) return null
  try {
    const payload = jwt.verify(token, JWT_VERIFY.secret, {
      algorithms: JWT_VERIFY.algorithms,
    }) as NhostJwtPayload
    if (!hasAdminRole(payload as unknown as Record<string, unknown>)) return null
    return {
      type: 'session',
      userId: getUserIdFromJwtPayload(payload as unknown as Record<string, unknown>),
      scopes: ['*'],
    }
  } catch {
    return null
  }
}

async function verifyMcpKey(token: string): Promise<AdminApiAuthContext | null> {
  if (!isMcpApiKeyFormat(token)) return null
  const row = await lookupMcpApiKey(token)
  if (!row) return null
  touchMcpApiKey(row.id).catch((err) => {
    console.warn('[admin-api-auth] touch failed', err)
  })
  return {
    type: 'mcp',
    userId: row.admin_user_id,
    scopes: row.scopes?.length ? row.scopes : ['*'],
    mcpKeyId: row.id,
  }
}

/** Accept MCP Bearer key, admin JWT, or legacy x-admin-secret (portal proxy during migration). */
export async function resolveAdminApiAuth(
  req: Request,
  res: Response,
): Promise<AdminApiAuthContext | null> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token) {
      const mcpAuth = await verifyMcpKey(token)
      if (mcpAuth) return mcpAuth
      const jwtAuth = await verifyNhostAdminJwt(token)
      if (jwtAuth) return jwtAuth
    }
  }

  const legacySecret = req.headers['x-admin-secret']
  if (legacySecret && legacySecret === ADMIN_SECRET) {
    return {
      type: 'session',
      userId: 'legacy-admin-secret',
      scopes: ['*'],
    }
  }

  adminError(res, 'Unauthorized', 401)
  return null
}

/** Session JWT only — MCP keys cannot manage themselves. */
export async function resolveAdminSessionAuth(
  req: Request,
  res: Response,
): Promise<AdminApiAuthContext | null> {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token && isMcpApiKeyFormat(token)) {
      adminError(res, 'MCP keys cannot manage MCP settings', 403)
      return null
    }
    const jwtAuth = await verifyNhostAdminJwt(token)
    if (jwtAuth) return jwtAuth
  }

  adminError(res, 'Unauthorized', 401)
  return null
}

export function getFunctionsBaseUrl(): string {
  const override = process.env.NHOST_FUNCTIONS_URL?.trim()
  if (override) return override.replace(/\/$/, '')

  const subdomain = process.env.NHOST_SUBDOMAIN?.trim()
  const region = process.env.NHOST_REGION?.trim()
  if (!subdomain || !region) {
    throw new Error('NHOST_SUBDOMAIN and NHOST_REGION are required')
  }
  return `https://${subdomain}.functions.${region}.nhost.run/v1`
}

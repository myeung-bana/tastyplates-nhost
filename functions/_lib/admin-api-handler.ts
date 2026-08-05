import type { Request, Response } from 'express'

import type { AdminApiAuthContext } from './admin-api-auth'
import { resolveAdminApiAuth, resolveAdminSessionAuth } from './admin-api-auth'
import { adminError } from './admin-api-respond'

type AdminHandler = (
  req: Request,
  res: Response,
  auth: AdminApiAuthContext,
) => Promise<void>

export function withAdminApiAuth(
  handler: AdminHandler,
  options?: { sessionOnly?: boolean },
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    try {
      const auth = options?.sessionOnly
        ? await resolveAdminSessionAuth(req, res)
        : await resolveAdminApiAuth(req, res)
      if (!auth) return
      await handler(req, res, auth)
    } catch (error) {
      console.error('[admin-api]', error)
      adminError(
        res,
        error instanceof Error ? error.message : 'Internal server error',
        500,
      )
    }
  }
}

export function parseQueryInt(value: string | null | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10)
  return Number.isNaN(n) ? fallback : n
}

export function readJsonBody<T extends Record<string, unknown>>(req: Request): T {
  const body = req.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as T
  }
  return {} as T
}

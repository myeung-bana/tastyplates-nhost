import type { Request, Response } from 'express'
import process from 'node:process'
import { requireAuth } from './_lib/auth'
import { ok } from './_lib/respond'

/**
 * Smoke-test endpoint — confirms routing, headers, and JWT flow work end-to-end.
 * Remove or gate behind NODE_ENV !== 'production' before going live.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return // requireAuth already sent 401

    ok(res, {
      message: 'Echo OK',
      query: req.query,
      user: {
        id: payload['https://hasura.io/jwt/claims']['x-hasura-user-id'],
        role: payload['https://hasura.io/jwt/claims']['x-hasura-default-role'],
      },
      node: process.version,
      arch: process.arch,
    })
  } catch (error) {
    console.error('[echo]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

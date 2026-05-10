import type { Request, Response } from 'express'
import process from 'node:process'
import { ok, fail } from '../_lib/respond'

export default async (_req: Request, res: Response): Promise<void> => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return fail(res, 'Not available in production', 403)
    }

    ok(res, { status: 'ok', timestamp: new Date().toISOString() })
  } catch (error) {
    console.error('[monitoring/graphql-stats]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

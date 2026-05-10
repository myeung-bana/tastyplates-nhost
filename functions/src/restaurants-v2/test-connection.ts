import type { Request, Response } from 'express'
import process from 'node:process'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const TEST_QUERY = `
  query TestConnection {
    restaurants(limit: 1) { id uuid title }
  }
`

export default async (_req: Request, res: Response): Promise<void> => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return fail(res, 'Not available in production', 403)
    }

    const result = await hasuraQuery(TEST_QUERY)

    if (result.errors?.length) {
      console.error('[restaurants-v2/test-connection]', result.errors)
      return fail(res, 'Hasura connection failed', 500)
    }

    ok(res, { status: 'ok', connected: true, timestamp: new Date().toISOString() })
  } catch (error) {
    console.error('[restaurants-v2/test-connection]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

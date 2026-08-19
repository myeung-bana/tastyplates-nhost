import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import {
  rebuildAllPalateRatingSummaries,
  type PalateRatingSource,
} from '../_lib/rebuildPalateRatingSummary'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const body = (req.body ?? {}) as { source?: string }
    const source =
      body.source === 'external' || body.source === 'first_party'
        ? (body.source as PalateRatingSource)
        : undefined

    const rebuilt = await rebuildAllPalateRatingSummaries(source)
    ok(res, { rebuilt, source: source ?? 'external+first_party' })
  } catch (error) {
    console.error('[admin/backfill-palate-rating-summaries]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

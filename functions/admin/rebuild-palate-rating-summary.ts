import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import {
  rebuildAllPalateRatingSummaries,
  rebuildPalateRatingSummary,
  type PalateRatingSource,
} from '../_lib/rebuildPalateRatingSummary'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseSource(raw: unknown): PalateRatingSource | 'both' {
  if (raw === 'external' || raw === 'first_party') return raw
  return 'both'
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const body = (req.body ?? {}) as { restaurant_uuid?: string; source?: string }
    const uuid = body.restaurant_uuid?.trim()
    if (!uuid) return fail(res, 'restaurant_uuid is required', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    const source = parseSource(body.source)
    if (source === 'both') {
      const [external, firstParty] = await Promise.all([
        rebuildPalateRatingSummary(uuid, 'external'),
        rebuildPalateRatingSummary(uuid, 'first_party'),
      ])
      return ok(res, {
        restaurant_uuid: uuid,
        external_rows: external.rows_upserted,
        first_party_rows: firstParty.rows_upserted,
      })
    }

    const result = await rebuildPalateRatingSummary(uuid, source)
    ok(res, { restaurant_uuid: uuid, source, rows_upserted: result.rows_upserted })
  } catch (error) {
    console.error('[admin/rebuild-palate-rating-summary]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

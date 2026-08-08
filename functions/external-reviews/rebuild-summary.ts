/**
 * POST `external-reviews/rebuild-summary`
 * Auth: admin Bearer / MCP key / x-admin-secret
 */
import type { Request, Response } from 'express'

import { resolveAdminApiAuth } from '../_lib/admin-api-auth'
import { ADMIN_SECRET } from '../_lib/env'
import { UUID_REGEX } from '../_lib/externalReviewTypes'
import {
  rebuildAllExternalReviewSummaries,
  rebuildExternalReviewSummary,
} from '../_lib/rebuildExternalReviewSummary'
import { fail, ok } from '../_lib/respond'

function isInternalAdminCall(req: Request): boolean {
  const legacySecret = req.headers['x-admin-secret']
  return Boolean(legacySecret && legacySecret === ADMIN_SECRET)
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    if (!isInternalAdminCall(req)) {
      const auth = await resolveAdminApiAuth(req, res)
      if (!auth) return
    }

    const body = (req.body ?? {}) as { restaurant_id?: string; restaurant_uuid?: string }
    const restaurantUuid =
      (typeof body.restaurant_uuid === 'string' ? body.restaurant_uuid.trim() : '') ||
      (typeof body.restaurant_id === 'string' ? body.restaurant_id.trim() : '')

    if (restaurantUuid) {
      if (!UUID_REGEX.test(restaurantUuid)) {
        return fail(res, 'Invalid restaurant UUID format', 400)
      }
      await rebuildExternalReviewSummary(restaurantUuid)
      ok(res, { rebuilt: 1 })
      return
    }

    const rebuilt = await rebuildAllExternalReviewSummaries()
    ok(res, { rebuilt })
  } catch (error) {
    console.error('[external-reviews/rebuild-summary]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

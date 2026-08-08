/**
 * POST `external-reviews/flag`
 * Auth: admin Bearer / MCP key / x-admin-secret
 */
import type { Request, Response } from 'express'

import { resolveAdminApiAuth } from '../_lib/admin-api-auth'
import { flagExternalReview } from '../_lib/externalReviewQueries'
import { UUID_REGEX } from '../_lib/externalReviewTypes'
import { rebuildExternalReviewSummary } from '../_lib/rebuildExternalReviewSummary'
import { fail, ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    const auth = await resolveAdminApiAuth(req, res)
    if (!auth) return

    const body = (req.body ?? {}) as {
      id?: string
      is_flagged?: boolean
      flagged_reason?: string
    }

    const id = body.id?.trim()
    if (!id || !UUID_REGEX.test(id)) {
      return fail(res, 'Valid id (uuid) is required', 400)
    }
    if (typeof body.is_flagged !== 'boolean') {
      return fail(res, 'is_flagged (boolean) is required', 400)
    }

    const flaggedReason =
      typeof body.flagged_reason === 'string' ? body.flagged_reason.trim() || null : null

    const updated = await flagExternalReview(id, body.is_flagged, flaggedReason)
    if (!updated) {
      return fail(res, 'External review not found', 404)
    }

    await rebuildExternalReviewSummary(updated.restaurant_uuid)

    ok(res, {
      id: updated.id,
      is_flagged: body.is_flagged,
      flagged_reason: flaggedReason,
    })
  } catch (error) {
    console.error('[external-reviews/flag]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

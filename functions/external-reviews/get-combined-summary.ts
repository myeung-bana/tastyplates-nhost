/**
 * GET `external-reviews/get-combined-summary`
 * Admin only (admin Bearer / MCP key / x-admin-secret). Does not expose raw review body text.
 */
import type { Request, Response } from 'express'
import { resolveAdminApiAuth } from '../_lib/admin-api-auth'

import { getCombinedSummary } from '../_lib/externalReviewCombined'
import { UUID_REGEX } from '../_lib/externalReviewTypes'
import { fail, ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    // Admin-only diagnostics (Rating Model v3 §10.3): admin Bearer / MCP key / x-admin-secret.
    const auth = await resolveAdminApiAuth(req, res)
    if (!auth) return

    if (req.method !== 'GET') {
      return fail(res, 'Method not allowed', 405)
    }

    const url = new URL(req.url, 'http://localhost')
    const restaurantUuid =
      url.searchParams.get('restaurant_uuid')?.trim() ??
      url.searchParams.get('restaurant_id')?.trim() ??
      url.searchParams.get('uuid')?.trim() ??
      ''

    if (!restaurantUuid) {
      return fail(res, 'restaurant_uuid is required', 400)
    }
    if (!UUID_REGEX.test(restaurantUuid)) {
      return fail(res, 'Invalid restaurant_uuid format', 400)
    }

    const data = await getCombinedSummary(restaurantUuid)
    ok(res, data)
  } catch (error) {
    console.error('[external-reviews/get-combined-summary]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

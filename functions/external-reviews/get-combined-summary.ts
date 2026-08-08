/**
 * GET `external-reviews/get-combined-summary`
 * Public — no auth required. Does not expose raw review body text.
 */
import type { Request, Response } from 'express'

import { getCombinedSummary } from '../_lib/externalReviewCombined'
import { UUID_REGEX } from '../_lib/externalReviewTypes'
import { fail, ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
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

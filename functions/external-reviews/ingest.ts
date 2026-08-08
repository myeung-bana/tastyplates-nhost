/**
 * POST `external-reviews/ingest`
 * Header: `x-apify-webhook-secret`
 *
 * Accepts transformed Apify review batch payload and upserts restaurant_external_reviews.
 */
import type { Request, Response } from 'express'

import { ingestExternalReviews, verifyApifyWebhookSecret } from '../_lib/externalReviewIngest'
import type { IngestPayload } from '../_lib/externalReviewTypes'
import { fail, ok } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    if (!verifyApifyWebhookSecret(req.headers['x-apify-webhook-secret'])) {
      return fail(res, 'Unauthorized', 401)
    }

    const payload = (req.body ?? {}) as IngestPayload
    if (!payload.platform?.trim()) {
      return fail(res, 'platform is required', 400)
    }
    if (!Array.isArray(payload.items)) {
      return fail(res, 'items must be an array', 400)
    }

    const result = await ingestExternalReviews(payload)
    ok(res, {
      ingested: result.ingested,
      skipped: result.skipped,
      failed: result.failed,
    })
  } catch (error) {
    console.error('[external-reviews/ingest]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

/**
 * POST `admin/trigger-apify-scrape`
 * Header: `x-admin-secret`
 * Body: `{ restaurant_uuid: uuid, source?: "google_maps" }`
 */
import type { Request, Response } from 'express'
import { z } from 'zod'

import {
  getApifyWebhookSecret,
  getFunctionsPublicBaseUrl,
  requireApifyConfig,
  startApifyActorRun,
} from '../_lib/apifyClient'
import { buildGoogleMapsActorInput } from '../_lib/apifyTransforms'
import { ADMIN_SECRET } from '../_lib/env'
import {
  buildScrapeSearchQuery,
  loadRestaurantForScrape,
  markExternalDataFailed,
  resolveGooglePlaceId,
  upsertExternalDataRunning,
} from '../_lib/restaurantExternalData'
import { fail, ok } from '../_lib/respond'
import { validate } from '../_lib/validate'

const BodySchema = z.object({
  restaurant_uuid: z.string().uuid(),
  source: z.enum(['google_maps', 'yelp', 'tripadvisor']).default('google_maps'),
})

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    const body = validate(req, res, BodySchema)
    if (!body) return

    if (body.source !== 'google_maps') {
      return fail(res, 'Only google_maps source is supported in phase 2', 400)
    }

    const restaurant = await loadRestaurantForScrape(body.restaurant_uuid)
    if (!restaurant) {
      return fail(res, 'Restaurant not found', 404)
    }

    const webhookSecret = getApifyWebhookSecret()
    if (!webhookSecret) {
      return fail(res, 'APIFY_WEBHOOK_SECRET is not configured', 503)
    }

    let config: { token: string; actorId: string }
    try {
      config = requireApifyConfig()
    } catch (configError) {
      return fail(res, configError instanceof Error ? configError.message : 'Apify not configured', 503)
    }

    const placeId = resolveGooglePlaceId(restaurant)
    const searchQuery = buildScrapeSearchQuery(restaurant)
    const actorInput = buildGoogleMapsActorInput({ placeId, searchQuery })
    const webhookUrl = `${getFunctionsPublicBaseUrl()}/admin/apify-webhook`

    const runningRow = await upsertExternalDataRunning({
      restaurantUuid: body.restaurant_uuid,
      source: body.source,
      apifyRunId: null,
    })

    let runId: string
    let datasetId: string | null
    try {
      const started = await startApifyActorRun({
        actorId: config.actorId,
        token: config.token,
        input: actorInput,
        webhookUrl,
        webhookSecret,
      })
      runId = started.runId
      datasetId = started.datasetId

      await upsertExternalDataRunning({
        restaurantUuid: body.restaurant_uuid,
        source: body.source,
        apifyRunId: runId,
      })
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Failed to start Apify run'
      await markExternalDataFailed(runningRow.id, message)
      return fail(res, message, 502)
    }

    ok(res, {
      restaurant_uuid: body.restaurant_uuid,
      source: body.source,
      sync_status: 'running',
      apify_run_id: runId,
      apify_dataset_id: datasetId,
      scrape_input: { placeId, searchQuery, actorInput },
      message: 'Apify run started. Results will arrive via webhook.',
    })
  } catch (error) {
    console.error('[admin/trigger-apify-scrape]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

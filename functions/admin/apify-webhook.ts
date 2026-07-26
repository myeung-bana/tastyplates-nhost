/**
 * POST `admin/apify-webhook`
 * Header: `x-apify-webhook-secret`
 *
 * Apify run completion webhook — fetches dataset and upserts restaurant_external_data.
 */
import type { Request, Response } from 'express'

import { fetchApifyDatasetItems, getApifyWebhookSecret, requireApifyConfig } from '../_lib/apifyClient'
import { transformApifyDataset } from '../_lib/apifyTransforms'
import {
  findExternalDataByRunId,
  markExternalDataFailed,
  markExternalDataSucceeded,
} from '../_lib/restaurantExternalData'
import { isExternalDataSource } from '../_lib/restaurantExternalDataTypes'
import { fail, ok } from '../_lib/respond'

interface ApifyWebhookPayload {
  eventType?: string
  resource?: {
    id?: string
    defaultDatasetId?: string
    status?: string
    statusMessage?: string
  }
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    const expectedSecret = getApifyWebhookSecret()
    if (!expectedSecret) {
      return fail(res, 'Webhook secret not configured', 503)
    }

    const providedSecret = req.headers['x-apify-webhook-secret']
    if (!providedSecret || providedSecret !== expectedSecret) {
      return fail(res, 'Unauthorized', 401)
    }

    const payload = (req.body ?? {}) as ApifyWebhookPayload
    const eventType = payload.eventType ?? ''
    const runId = payload.resource?.id?.trim()
    const datasetId = payload.resource?.defaultDatasetId?.trim() ?? null
    const statusMessage = payload.resource?.statusMessage?.trim()

    if (!runId) {
      return fail(res, 'Missing Apify run id in webhook payload', 400)
    }

    const row = await findExternalDataByRunId(runId)
    if (!row) {
      console.warn('[admin/apify-webhook] no row for run', runId)
      ok(res, { ignored: true, reason: 'No matching external data row' })
      return
    }

    if (eventType === 'ACTOR.RUN.SUCCEEDED') {
      if (!datasetId) {
        await markExternalDataFailed(row.id, 'Apify run succeeded but no dataset id was returned')
        return fail(res, 'Missing dataset id', 400)
      }

      const { token } = requireApifyConfig()
      const items = await fetchApifyDatasetItems(datasetId, token)

      if (items.length === 0) {
        await markExternalDataFailed(row.id, 'Apify dataset returned no items')
        ok(res, { processed: false, runId, reason: 'empty dataset' })
        return
      }

      if (!isExternalDataSource(row.source)) {
        await markExternalDataFailed(row.id, `Unsupported source: ${row.source}`)
        return fail(res, 'Unsupported source on row', 400)
      }

      const normalized = transformApifyDataset(row.source, items)
      await markExternalDataSucceeded(row.id, normalized, datasetId)

      ok(res, {
        processed: true,
        runId,
        restaurant_uuid: row.restaurant_uuid,
        source: row.source,
        itemCount: items.length,
      })
      return
    }

    const failureMessage =
      statusMessage ||
      payload.resource?.status ||
      eventType ||
      'Apify run did not succeed'

    await markExternalDataFailed(row.id, String(failureMessage))
    ok(res, { processed: true, runId, failed: true, message: failureMessage })
  } catch (error) {
    console.error('[admin/apify-webhook]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

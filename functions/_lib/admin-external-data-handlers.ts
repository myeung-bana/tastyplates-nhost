import {
  getApifyWebhookSecret,
  getFunctionsPublicBaseUrl,
  requireApifyConfig,
  startApifyActorRun,
} from './apifyClient'
import { buildGoogleMapsActorInput } from './apifyTransforms'
import {
  buildScrapeSearchQuery,
  listExternalDataByRestaurant,
  loadRestaurantForScrape,
  markExternalDataFailed,
  resolveGooglePlaceId,
  upsertExternalDataRunning,
} from './restaurantExternalData'

export async function getExternalData(restaurantUuid: string) {
  const rows = await listExternalDataByRestaurant(restaurantUuid)
  return {
    success: true as const,
    data: { restaurant_uuid: restaurantUuid, external_data: rows },
  }
}

export async function triggerExternalScrape(body: {
  restaurant_uuid: string
  source?: 'google_maps' | 'yelp' | 'tripadvisor'
}) {
  const source = body.source ?? 'google_maps'
  if (source !== 'google_maps') {
    throw new Error('Only google_maps source is supported in phase 2')
  }

  const restaurant = await loadRestaurantForScrape(body.restaurant_uuid)
  if (!restaurant) throw new Error('Restaurant not found')

  const webhookSecret = getApifyWebhookSecret()
  if (!webhookSecret) throw new Error('APIFY_WEBHOOK_SECRET is not configured')

  const config = requireApifyConfig()
  const placeId = resolveGooglePlaceId(restaurant)
  const searchQuery = buildScrapeSearchQuery(restaurant)
  const actorInput = buildGoogleMapsActorInput({ placeId, searchQuery })
  const webhookUrl = `${getFunctionsPublicBaseUrl()}/admin/apify-webhook`

  const runningRow = await upsertExternalDataRunning({
    restaurantUuid: body.restaurant_uuid,
    source,
    apifyRunId: null,
  })

  try {
    const started = await startApifyActorRun({
      actorId: config.actorId,
      token: config.token,
      input: actorInput,
      webhookUrl,
      webhookSecret,
    })

    await upsertExternalDataRunning({
      restaurantUuid: body.restaurant_uuid,
      source,
      apifyRunId: started.runId,
    })

    return {
      success: true as const,
      data: {
        restaurant_uuid: body.restaurant_uuid,
        source,
        sync_status: 'running',
        apify_run_id: started.runId,
        apify_dataset_id: started.datasetId,
        scrape_input: { placeId, searchQuery, actorInput },
        message: 'Apify run started. Results will arrive via webhook.',
      },
    }
  } catch (startError) {
    const message = startError instanceof Error ? startError.message : 'Failed to start Apify run'
    await markExternalDataFailed(runningRow.id, message)
    throw new Error(message)
  }
}

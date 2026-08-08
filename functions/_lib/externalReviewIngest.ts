import { getApifyWebhookSecret } from './apifyClient'
import { tagExternalReview } from './externalReviewTagger'
import {
  clampRating,
  normalizeSourcePlatform,
  type IngestPayload,
  type IngestResult,
} from './externalReviewTypes'
import { upsertExternalReview } from './externalReviewQueries'
import { resolveRestaurantUuidByPlaceId } from './resolveRestaurantByPlaceId'
import { scheduleExternalReviewSummaryRebuildMany } from './rebuildExternalReviewSummary'

export function verifyApifyWebhookSecret(
  provided: string | string[] | undefined,
): boolean {
  const expected = getApifyWebhookSecret()
  if (!expected) return false
  const value = Array.isArray(provided) ? provided[0] : provided
  return Boolean(value && value === expected)
}

export async function ingestExternalReviews(payload: IngestPayload): Promise<IngestResult> {
  const platform = normalizeSourcePlatform(payload.platform)
  if (!platform) {
    throw new Error(`Unsupported platform: ${payload.platform}`)
  }

  const batchId = payload.apify_run_id?.trim() || null
  const items = Array.isArray(payload.items) ? payload.items : []

  let ingested = 0
  let skipped = 0
  let failed = 0
  const affected = new Set<string>()

  for (const item of items) {
    try {
      const sourceReviewId = item.review_id?.trim()
      const placeId = item.place_id?.trim()
      const rating = clampRating(item.rating)

      if (!sourceReviewId || !placeId || rating == null) {
        skipped++
        continue
      }

      const restaurantUuid = await resolveRestaurantUuidByPlaceId(placeId)
      if (!restaurantUuid) {
        skipped++
        continue
      }

      const body = item.text?.trim() || null
      const tags = tagExternalReview(body, rating)

      const updatedUuid = await upsertExternalReview({
        restaurant_uuid: restaurantUuid,
        source_platform: platform,
        source_review_id: sourceReviewId,
        rating,
        body,
        language: tags.language,
        palates: tags.palates,
        sentiment: tags.sentiment,
        reviewed_at: item.published_at?.trim() || null,
        source_url: item.url?.trim() || null,
        source_author_name: item.author_name?.trim() || null,
        source_author_id: item.author_id?.trim() || null,
        ingest_batch_id: batchId,
      })

      if (updatedUuid) {
        affected.add(updatedUuid)
        ingested++
      } else {
        failed++
      }
    } catch (error) {
      console.error('[ingestExternalReviews] item failed', error)
      failed++
    }
  }

  scheduleExternalReviewSummaryRebuildMany([...affected])

  return {
    ingested,
    skipped,
    failed,
    affected_restaurant_uuids: [...affected],
  }
}

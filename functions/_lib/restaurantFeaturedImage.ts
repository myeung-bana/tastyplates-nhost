import { hasuraAdmin } from './hasura'
import {
  needsFeaturedImageBackfill,
  resolveEffectiveFeaturedImageUrl,
} from './featuredImageUtils'
import { fetchPlaceCacheSafe } from './listEnrichment'

const GET_RESTAURANT_FEATURED = `
  query GetRestaurantFeaturedImage($uuid: uuid!) {
    restaurants_by_pk(uuid: $uuid) {
      uuid
      featured_image_url
      google_place_id
    }
  }
`

const UPDATE_RESTAURANT_FEATURED = `
  mutation SetRestaurantFeaturedImage($uuid: uuid!, $url: String!) {
    update_restaurants_by_pk(pk_columns: { uuid: $uuid }, _set: { featured_image_url: $url }) {
      uuid
      featured_image_url
    }
  }
`

type ReviewImageInput = {
  url: string
  thumbnail_url?: string | null
  display_order?: number | null
}

function pickFirstReviewImageUrl(images: ReviewImageInput[] | null | undefined): string | null {
  if (!images?.length) return null
  const sorted = [...images].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  )
  for (const img of sorted) {
    const url = resolveEffectiveFeaturedImageUrl(img.url)
    if (url) return url
  }
  return null
}

/**
 * When a restaurant has no real featured image, try Google place cache, then review photos.
 * Placeholder sentinel URLs are treated as missing and may be replaced.
 * Never throws — logs and continues if the update fails.
 */
export async function backfillRestaurantFeaturedFromReview(
  restaurantUuid: string,
  images: ReviewImageInput[] | null | undefined,
): Promise<void> {
  try {
    const data = await hasuraAdmin<{
      restaurants_by_pk: {
        featured_image_url: string | null
        google_place_id: string | null
      } | null
    }>(GET_RESTAURANT_FEATURED, { uuid: restaurantUuid })

    const row = data.restaurants_by_pk
    if (!row) return
    if (!needsFeaturedImageBackfill(row.featured_image_url)) return

    let candidateUrl: string | null = null

    const placeId = row.google_place_id?.trim()
    if (placeId) {
      const cacheMap = await fetchPlaceCacheSafe([placeId])
      candidateUrl = resolveEffectiveFeaturedImageUrl(
        cacheMap.get(placeId)?.primary_photo_url,
      )
    }

    if (!candidateUrl) {
      candidateUrl = pickFirstReviewImageUrl(images)
    }

    if (!candidateUrl) return

    await hasuraAdmin(UPDATE_RESTAURANT_FEATURED, {
      uuid: restaurantUuid,
      url: candidateUrl,
    })
  } catch (error) {
    console.warn('[restaurantFeaturedImage] backfill failed:', error)
  }
}

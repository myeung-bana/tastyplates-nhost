import { hasuraAdmin } from './hasura'

const GET_RESTAURANT_FEATURED = `
  query GetRestaurantFeaturedImage($uuid: uuid!) {
    restaurants_by_pk(uuid: $uuid) {
      uuid
      featured_image_url
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
    const url = img.url?.trim()
    if (url && url.startsWith('http')) return url
  }
  return null
}

/**
 * When a restaurant has no featured image, use the first uploaded review photo.
 * Never throws — logs and continues if the update fails.
 */
export async function backfillRestaurantFeaturedFromReview(
  restaurantUuid: string,
  images: ReviewImageInput[] | null | undefined,
): Promise<void> {
  const candidateUrl = pickFirstReviewImageUrl(images)
  if (!candidateUrl) return

  try {
    const data = await hasuraAdmin<{
      restaurants_by_pk: { featured_image_url: string | null } | null
    }>(GET_RESTAURANT_FEATURED, { uuid: restaurantUuid })

    const current = data.restaurants_by_pk?.featured_image_url?.trim()
    if (current) return

    await hasuraAdmin(UPDATE_RESTAURANT_FEATURED, {
      uuid: restaurantUuid,
      url: candidateUrl,
    })
  } catch (error) {
    console.warn('[restaurantFeaturedImage] backfill failed:', error)
  }
}

import { hasuraAdmin } from './hasura'
import {
  needsFeaturedImageBackfill,
  resolveEffectiveFeaturedImageUrl,
} from './featuredImageUtils'
import { fetchPlaceCacheSafe } from './listEnrichment'

type RowWithFeatured = {
  uuid?: string | null
  featured_image_url?: string | null
  google_place_id?: string | null
}

const PERSIST_FEATURED_IMAGE = `
  mutation PersistRestaurantFeaturedImage($uuid: uuid!, $url: String!) {
    update_restaurants_by_pk(pk_columns: { uuid: $uuid }, _set: { featured_image_url: $url }) {
      uuid
    }
  }
`

function schedulePersistFeaturedImage(uuid: string, url: string): void {
  void hasuraAdmin(PERSIST_FEATURED_IMAGE, { uuid, url }).catch((error) => {
    console.warn('[applyFeaturedImageFallback] persist failed:', error)
  })
}

/** Fill missing `featured_image_url` from `google_place_cache.primary_photo_url`. */
export async function applyFeaturedImageFromPlaceCache<T extends RowWithFeatured>(
  rows: T[],
): Promise<T[]> {
  const placeIds = [
    ...new Set(
      rows
        .filter(
          (r) =>
            needsFeaturedImageBackfill(r.featured_image_url) && r.google_place_id?.trim(),
        )
        .map((r) => r.google_place_id!.trim()),
    ),
  ]
  if (placeIds.length === 0) {
    return rows.map((row) => ({
      ...row,
      featured_image_url: resolveEffectiveFeaturedImageUrl(row.featured_image_url),
    }))
  }

  const cacheMap = await fetchPlaceCacheSafe(placeIds)
  if (cacheMap.size === 0) {
    return rows.map((row) => ({
      ...row,
      featured_image_url: resolveEffectiveFeaturedImageUrl(row.featured_image_url),
    }))
  }

  return rows.map((row) => {
    const effective = resolveEffectiveFeaturedImageUrl(row.featured_image_url)
    if (effective) return { ...row, featured_image_url: effective }

    const placeId = row.google_place_id?.trim()
    if (!placeId) return { ...row, featured_image_url: null }

    const photo = resolveEffectiveFeaturedImageUrl(
      cacheMap.get(placeId)?.primary_photo_url,
    )
    if (!photo) return { ...row, featured_image_url: null }

    const uuid = row.uuid?.trim()
    if (uuid) schedulePersistFeaturedImage(uuid, photo)

    return { ...row, featured_image_url: photo }
  })
}

export async function applyFeaturedImageFromPlaceCacheOne<T extends RowWithFeatured>(
  row: T | null | undefined,
): Promise<T | null | undefined> {
  if (!row) return row
  const [enriched] = await applyFeaturedImageFromPlaceCache([row])
  return enriched
}

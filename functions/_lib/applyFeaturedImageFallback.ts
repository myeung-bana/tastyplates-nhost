import { fetchPlaceCacheSafe } from './listEnrichment'

type RowWithFeatured = {
  featured_image_url?: string | null
  google_place_id?: string | null
}

/** Fill missing `featured_image_url` from `google_place_cache.primary_photo_url`. */
export async function applyFeaturedImageFromPlaceCache<T extends RowWithFeatured>(
  rows: T[],
): Promise<T[]> {
  const placeIds = [
    ...new Set(
      rows
        .filter((r) => !r.featured_image_url?.trim() && r.google_place_id?.trim())
        .map((r) => r.google_place_id!.trim()),
    ),
  ]
  if (placeIds.length === 0) return rows

  const cacheMap = await fetchPlaceCacheSafe(placeIds)
  if (cacheMap.size === 0) return rows

  return rows.map((row) => {
    if (row.featured_image_url?.trim()) return row
    const placeId = row.google_place_id?.trim()
    if (!placeId) return row
    const photo = cacheMap.get(placeId)?.primary_photo_url?.trim()
    if (!photo) return row
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

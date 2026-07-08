/**
 * Fetch a Google Places photo by reference and persist it to Nhost Storage.
 * Used when user-created restaurants are seeded from Google Place Details.
 */
const PLACES_PHOTO_BASE = 'https://maps.googleapis.com/maps/api/place/photo'

function getGoogleMapsApiKey(): string | null {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim()
  return key && key.length > 0 ? key : null
}

export function buildGooglePlacePhotoUrl(photoReference: string, maxWidth = 1200): string | null {
  const key = getGoogleMapsApiKey()
  if (!key) return null
  const ref = encodeURIComponent(photoReference.trim())
  if (!ref) return null
  return `${PLACES_PHOTO_BASE}?maxwidth=${maxWidth}&photoreference=${ref}&key=${encodeURIComponent(key)}`
}

export async function ingestGooglePlacePhoto(
  photoReference: string,
  userId: string,
  options?: { maxWidth?: number; filenameHint?: string },
): Promise<string | null> {
  try {
    const photoUrl = buildGooglePlacePhotoUrl(photoReference, options?.maxWidth ?? 1200)
    if (!photoUrl) {
      console.warn('[ingestGooglePlacePhoto] GOOGLE_MAPS_API_KEY is not set')
      return null
    }

    const response = await fetch(photoUrl)
    if (!response.ok) {
      console.warn('[ingestGooglePlacePhoto] Google fetch failed:', response.status, response.statusText)
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) {
      console.warn('[ingestGooglePlacePhoto] Empty image response')
      return null
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg'
    const ext = contentType.includes('webp')
      ? 'webp'
      : contentType.includes('png')
        ? 'png'
        : 'jpg'
    const safeHint = (options?.filenameHint ?? 'google-place').replace(/[^\w-]+/g, '-').slice(0, 80)
    const filename = `${safeHint}.${ext}`

    const { processMediaUpload } = await import('./media-upload/processUpload')
    const result = await processMediaUpload(
      { buffer, mimetype: contentType, filename },
      userId,
      { compress: true },
    )
    return result.fileUrl
  } catch (error) {
    console.warn('[ingestGooglePlacePhoto]', error)
    return null
  }
}

/**
 * Prefer ingested Nhost Storage URL; fall back to a live Google Places photo URL
 * when ingest fails (missing key, storage error, etc.).
 */
export async function resolveGoogleFeaturedImageUrl(
  photoReference: string,
  userId: string,
  options?: { maxWidth?: number; filenameHint?: string },
): Promise<string | null> {
  const ref = photoReference.trim()
  if (!ref) return null

  const ingested = await ingestGooglePlacePhoto(ref, userId, options)
  if (ingested) return ingested

  const fallbackUrl = buildGooglePlacePhotoUrl(ref, options?.maxWidth ?? 1200)
  if (fallbackUrl) {
    console.warn('[ingestGooglePlacePhoto] using Google photo URL fallback (ingest failed)')
  }
  return fallbackUrl
}

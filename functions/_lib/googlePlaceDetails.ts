const PLACES_DETAILS_BASE = 'https://maps.googleapis.com/maps/api/place/details/json'

function getGoogleMapsApiKey(): string | null {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim()
  return key && key.length > 0 ? key : null
}

interface PlaceDetailsPayload {
  result?: {
    photos?: Array<{ photo_reference?: string }>
  }
  status?: string
  error_message?: string
}

/** Fetch the primary Google photo reference for a place id (server-side, one request). */
export async function fetchGooglePlacePhotoReference(placeId: string): Promise<string | null> {
  const key = getGoogleMapsApiKey()
  const id = placeId.trim()
  if (!key || !id) return null

  const params = new URLSearchParams({
    place_id: id,
    fields: 'photos',
    key,
  })

  try {
    const res = await fetch(`${PLACES_DETAILS_BASE}?${params}`)
    if (!res.ok) {
      console.warn('[googlePlaceDetails] HTTP', res.status, res.statusText)
      return null
    }

    const json = (await res.json()) as PlaceDetailsPayload
    if (json.status !== 'OK') {
      console.warn('[googlePlaceDetails]', json.status, json.error_message ?? '')
      return null
    }

    const ref = json.result?.photos?.[0]?.photo_reference?.trim()
    return ref && ref.length > 0 ? ref : null
  } catch (error) {
    console.warn('[googlePlaceDetails]', error)
    return null
  }
}

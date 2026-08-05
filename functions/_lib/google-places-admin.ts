import process from 'node:process'

import { convertGooglePlacesHoursToBusinessHours } from './business-hours-utils'

const PLACES_DETAILS_BASE = 'https://maps.googleapis.com/maps/api/place/details/json'
const PLACES_TEXT_SEARCH_BASE = 'https://maps.googleapis.com/maps/api/place/textsearch/json'

export interface GoogleAddressPayload {
  place_id?: string
  street_address?: string
  street_number?: string
  street_name?: string
  city?: string
  state?: string
  state_short?: string
  post_code?: string
  country?: string
  country_short?: string
}

export interface PlaceDetailsResult {
  place_id: string
  name: string
  phone: string
  website: string
  description: string
  opening_hours_text: string
  business_hours: ReturnType<typeof convertGooglePlacesHoursToBusinessHours>
  latitude: number | null
  longitude: number | null
  formatted_address: string
  address: GoogleAddressPayload
  photo_urls: string[]
}

export interface PlaceSearchResult {
  place_id: string
  name: string
  formatted_address: string
  latitude: number | null
  longitude: number | null
}

function getGoogleMapsApiKey(): string {
  const key =
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim()
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not configured')
  return key
}

function parseAddressComponents(
  components: Array<{ long_name: string; short_name: string; types: string[] }> | undefined,
): GoogleAddressPayload {
  const result: GoogleAddressPayload = {}
  if (!components) return result
  for (const c of components) {
    if (c.types.includes('street_number')) result.street_number = c.long_name
    if (c.types.includes('route')) result.street_name = c.long_name
    if (c.types.includes('locality')) result.city = c.long_name
    if (c.types.includes('administrative_area_level_1')) {
      result.state = c.long_name
      result.state_short = c.short_name
    }
    if (c.types.includes('postal_code')) result.post_code = c.long_name
    if (c.types.includes('country')) {
      result.country = c.long_name
      result.country_short = c.short_name
    }
  }
  if (result.street_number && result.street_name) {
    result.street_address = `${result.street_number} ${result.street_name}`
  }
  return result
}

function photoUrl(photoReference: string, maxWidth = 1600): string {
  const params = new URLSearchParams({
    maxwidth: String(maxWidth),
    photo_reference: photoReference,
    key: getGoogleMapsApiKey(),
  })
  return `https://maps.googleapis.com/maps/api/place/photo?${params.toString()}`
}

export function resolveGooglePlaceId(explicitPlaceId: unknown, address: unknown): string | undefined {
  if (typeof explicitPlaceId === 'string' && explicitPlaceId.trim()) return explicitPlaceId.trim()
  if (address && typeof address === 'object' && address !== null) {
    const placeId = (address as { place_id?: string }).place_id
    if (typeof placeId === 'string' && placeId.trim()) return placeId.trim()
  }
  return undefined
}

export async function fetchPlaceDetails(placeId: string): Promise<PlaceDetailsResult | null> {
  const id = placeId.trim()
  if (!id) return null
  const params = new URLSearchParams({
    place_id: id,
    fields: [
      'place_id', 'name', 'formatted_phone_number', 'website', 'opening_hours',
      'editorial_summary', 'reviews', 'formatted_address', 'geometry',
      'address_components', 'photos',
    ].join(','),
    key: getGoogleMapsApiKey(),
  })
  const res = await fetch(`${PLACES_DETAILS_BASE}?${params}`)
  if (!res.ok) return null
  const json = (await res.json()) as {
    status?: string
    result?: {
      place_id?: string
      name?: string
      formatted_phone_number?: string
      website?: string
      editorial_summary?: { overview?: string }
      reviews?: Array<{ text?: string }>
      opening_hours?: { weekday_text?: string[] }
      formatted_address?: string
      geometry?: { location?: { lat?: number; lng?: number } }
      address_components?: Array<{ long_name: string; short_name: string; types: string[] }>
      photos?: Array<{ photo_reference?: string }>
    }
  }
  if (json.status !== 'OK' || !json.result) return null
  const place = json.result
  const weekdayText = place.opening_hours?.weekday_text ?? []
  let description = place.editorial_summary?.overview ?? ''
  if (!description && place.reviews?.[0]?.text) description = place.reviews[0].text
  const address = parseAddressComponents(place.address_components)
  address.place_id = place.place_id ?? id
  const photoRefs = (place.photos ?? [])
    .map((p) => p.photo_reference?.trim())
    .filter((ref): ref is string => Boolean(ref))
    .slice(0, 5)
  return {
    place_id: place.place_id ?? id,
    name: place.name ?? '',
    phone: place.formatted_phone_number ?? '',
    website: place.website ?? '',
    description,
    opening_hours_text: weekdayText.join('\n'),
    business_hours: convertGooglePlacesHoursToBusinessHours(weekdayText),
    latitude: place.geometry?.location?.lat ?? null,
    longitude: place.geometry?.location?.lng ?? null,
    formatted_address: place.formatted_address ?? '',
    address,
    photo_urls: photoRefs.map((ref) => photoUrl(ref)),
  }
}

export async function searchPlaces(query: string, location?: string): Promise<PlaceSearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const params = new URLSearchParams({ query: location?.trim() ? `${q} ${location.trim()}` : q, key: getGoogleMapsApiKey() })
  const res = await fetch(`${PLACES_TEXT_SEARCH_BASE}?${params}`)
  if (!res.ok) return []
  const json = (await res.json()) as {
    status?: string
    results?: Array<{
      place_id?: string
      name?: string
      formatted_address?: string
      geometry?: { location?: { lat?: number; lng?: number } }
    }>
  }
  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') return []
  return (json.results ?? []).slice(0, 10).map((r) => ({
    place_id: r.place_id ?? '',
    name: r.name ?? '',
    formatted_address: r.formatted_address ?? '',
    latitude: r.geometry?.location?.lat ?? null,
    longitude: r.geometry?.location?.lng ?? null,
  }))
}

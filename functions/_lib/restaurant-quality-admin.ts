export type RestaurantQualityFilter =
  | 'all'
  | 'needs_location'
  | 'missing_featured_image'
  | 'needs_fix'
  | 'complete'
  | 'incomplete'
  | 'missing_image'

export interface RestaurantQualityFields {
  listing_street?: string
  latitude?: number | null
  longitude?: number | null
  featured_image_url?: string
  uploaded_images?: string[]
  address?: Record<string, unknown>
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

function hasAddressField(address: Record<string, unknown> | undefined, key: string): boolean {
  return hasText(address?.[key] as string | undefined)
}

export function isMissingFeaturedImage(restaurant: RestaurantQualityFields): boolean {
  return !hasText(restaurant.featured_image_url)
}

export function hasIncompleteLocation(restaurant: RestaurantQualityFields): boolean {
  const address = restaurant.address
  const hasStreet = hasText(restaurant.listing_street) || hasAddressField(address, 'street_address')
  const hasCity = hasAddressField(address, 'city')
  const hasState = hasAddressField(address, 'state_short') || hasAddressField(address, 'state')
  const hasPostCode = hasAddressField(address, 'post_code')
  const hasCountry = hasAddressField(address, 'country') || hasAddressField(address, 'country_short')
  const hasPlaceId = hasAddressField(address, 'place_id')
  const hasCoordinates =
    restaurant.latitude != null &&
    restaurant.longitude != null &&
    !Number.isNaN(Number(restaurant.latitude)) &&
    !Number.isNaN(Number(restaurant.longitude))
  return !hasStreet || !hasCity || !hasState || !hasPostCode || !hasCountry || !hasPlaceId || !hasCoordinates
}

export function needsAnyFix(restaurant: RestaurantQualityFields): boolean {
  return hasIncompleteLocation(restaurant) || isMissingFeaturedImage(restaurant)
}

export function normalizeQualityFilter(raw: string | null | undefined): RestaurantQualityFilter {
  switch (raw) {
    case 'complete':
      return 'complete'
    case 'incomplete':
      return 'needs_fix'
    case 'missing_image':
      return 'missing_featured_image'
    case 'needs_location':
    case 'missing_featured_image':
    case 'needs_fix':
      return raw
    default:
      return 'all'
  }
}

export function matchesQualityFilter(
  restaurant: RestaurantQualityFields,
  filter: RestaurantQualityFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'needs_location':
      return hasIncompleteLocation(restaurant)
    case 'missing_featured_image':
    case 'missing_image':
      return isMissingFeaturedImage(restaurant)
    case 'needs_fix':
    case 'incomplete':
      return needsAnyFix(restaurant)
    case 'complete':
      return !needsAnyFix(restaurant)
    default:
      return true
  }
}

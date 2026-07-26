import type { ExternalDataSource, NormalizedExternalData } from './restaurantExternalDataTypes'

function asNumber(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const strings = value
    .map((v) => (typeof v === 'string' ? v.trim() : typeof v === 'object' && v && 'name' in v ? String((v as { name?: unknown }).name ?? '').trim() : ''))
    .filter(Boolean)
  return strings.length > 0 ? strings : null
}

function pickFirstItem(items: Record<string, unknown>[]): Record<string, unknown> {
  return items[0] ?? {}
}

/**
 * Maps common Apify Google Places / Maps scraper fields to our normalized shape.
 * Keeps full first item (or merged items) in raw_payload for audit.
 */
export function transformGoogleMapsDataset(items: Record<string, unknown>[]): NormalizedExternalData {
  const primary = pickFirstItem(items)

  const rating =
    asNumber(primary.rating) ??
    asNumber(primary.totalScore) ??
    asNumber(primary.stars) ??
    asNumber(primary.averageRating)

  const reviewCountRaw =
    primary.reviewsCount ??
    primary.userRatingsTotal ??
    primary.reviewCount ??
    primary.numberOfReviews

  const reviewCount = asNumber(reviewCountRaw)
  const external_review_count =
    reviewCount != null && reviewCount >= 0 ? Math.floor(reviewCount) : null

  const price =
    (typeof primary.priceLevel === 'string' && primary.priceLevel) ||
    (typeof primary.price === 'string' && primary.price) ||
    (typeof primary.priceRange === 'string' && primary.priceRange) ||
    null

  const cuisine_tags =
    asStringArray(primary.categories) ??
    asStringArray(primary.categoryNames) ??
    asStringArray(primary.cuisine) ??
    asStringArray(primary.types)

  const popular_dishes =
    asStringArray(primary.popularDishes) ??
    asStringArray(primary.menuItems) ??
    asStringArray(primary.dishes)

  const opening_hours =
    primary.openingHours ??
    primary.openingHoursSpecification ??
    primary.hours ??
    null

  const photo_urls =
    asStringArray(primary.imageUrls) ??
    asStringArray(primary.images) ??
    (typeof primary.imageUrl === 'string' ? [primary.imageUrl] : null)

  return {
    external_rating: rating != null && rating >= 0 && rating <= 5 ? Number(rating.toFixed(1)) : null,
    external_review_count,
    price_level: price,
    cuisine_tags,
    popular_dishes,
    opening_hours,
    photo_urls,
    raw_payload: {
      itemCount: items.length,
      primary,
      items: items.slice(0, 5),
    },
  }
}

export function transformApifyDataset(
  source: ExternalDataSource,
  items: Record<string, unknown>[],
): NormalizedExternalData {
  if (source === 'google_maps') {
    return transformGoogleMapsDataset(items)
  }

  const primary = pickFirstItem(items)
  return {
    external_rating: null,
    external_review_count: null,
    price_level: null,
    cuisine_tags: null,
    popular_dishes: null,
    opening_hours: null,
    photo_urls: null,
    raw_payload: { itemCount: items.length, primary, items: items.slice(0, 5) },
  }
}

export function buildGoogleMapsActorInput(input: {
  placeId: string | null
  searchQuery: string
  maxPlaces?: number
}): Record<string, unknown> {
  if (input.placeId) {
    return {
      placeIds: [input.placeId],
      maxCrawledPlaces: input.maxPlaces ?? 1,
      language: 'en',
    }
  }

  return {
    searchStringsArray: [input.searchQuery],
    maxCrawledPlaces: input.maxPlaces ?? 1,
    language: 'en',
  }
}

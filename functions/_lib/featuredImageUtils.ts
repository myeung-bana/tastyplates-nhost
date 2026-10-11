/** Legacy / sentinel URLs — treated as “no featured image” for fallback and backfill. */
const PLACEHOLDER_SUBSTRINGS = [
  'tastyplates_placeholder_portrait',
  'tastyplates_placeholder_landscape',
] as const

export function isPlaceholderFeaturedImage(url: string | null | undefined): boolean {
  const trimmed = url?.trim()
  if (!trimmed) return false
  const lower = trimmed.toLowerCase()
  return PLACEHOLDER_SUBSTRINGS.some((s) => lower.includes(s))
}

/** Returns a usable featured image URL, or null when empty or a placeholder sentinel. */
export function resolveEffectiveFeaturedImageUrl(
  url: string | null | undefined,
): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  if (isPlaceholderFeaturedImage(trimmed)) return null
  return trimmed
}

export function needsFeaturedImageBackfill(url: string | null | undefined): boolean {
  return resolveEffectiveFeaturedImageUrl(url) == null
}

const GOOGLE_PHOTO_HOSTS = ['maps.googleapis.com', 'googleusercontent.com'] as const

/** Google Places photo URLs (may carry the Maps API key) and scraped googleusercontent links. */
export function isGooglePhotoUrl(url: string | null | undefined): boolean {
  const trimmed = url?.trim()
  if (!trimmed) return false
  try {
    const host = new URL(trimmed).hostname.toLowerCase()
    return GOOGLE_PHOTO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/**
 * Like `resolveEffectiveFeaturedImageUrl`, but also rejects Google-hosted URLs.
 * Use for fallback candidates that may be persisted onto `restaurants.featured_image_url`.
 */
export function resolveStorableFeaturedImageUrl(url: string | null | undefined): string | null {
  const effective = resolveEffectiveFeaturedImageUrl(url)
  return effective && !isGooglePhotoUrl(effective) ? effective : null
}

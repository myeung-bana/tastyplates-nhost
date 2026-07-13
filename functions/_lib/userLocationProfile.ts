import { hasuraQuery } from './hasura'

const GET_LOCATION_BY_SLUG = `
  query GetRestaurantLocationBySlug($slug: String!) {
    restaurant_locations(
      where: { slug: { _eq: $slug }, is_active: { _eq: true } }
      limit: 1
    ) {
      id
      slug
      name
      type
      latitude
      longitude
    }
  }
`

const GET_LOCATION_BY_ID = `
  query GetRestaurantLocationById($id: Int!) {
    restaurant_locations(
      where: { id: { _eq: $id }, is_active: { _eq: true } }
      limit: 1
    ) {
      id
      slug
      name
      type
      latitude
      longitude
    }
  }
`

type DbLocationRow = {
  id: number
  slug: string
  name: string
  type: string
  latitude: number | null
  longitude: number | null
}

export type UserLocationSnapshot = {
  location_id: number | null
  slug: string | null
  label: string
  type: string
  latitude: number | null
  longitude: number | null
  google_place_id?: string | null
}

export type StoredUserLocationFields = {
  location_id: number | null
  location_slug: string | null
  latitude: number | null
  longitude: number | null
  location_label: string | null
  google_place_id: string | null
}

export type UserLocationInput = {
  location_id?: number | null
  location_slug?: string | null
  slug?: string | null
  label?: string | null
  latitude?: number | null
  longitude?: number | null
  google_place_id?: string | null
}

export function readLocationInput(raw: unknown): UserLocationInput | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const locationIdRaw = o.location_id ?? o.locationId
  const locationSlugRaw = o.location_slug ?? o.locationSlug ?? o.slug
  const slugRaw = o.slug

  let location_id: number | null | undefined
  if (locationIdRaw === null) location_id = null
  else if (locationIdRaw === undefined) location_id = undefined
  else location_id = normalizeId(locationIdRaw) ?? undefined

  const location_slug =
    locationSlugRaw === null
      ? null
      : typeof locationSlugRaw === 'string'
        ? locationSlugRaw
        : undefined

  const slug =
    slugRaw === null ? null : typeof slugRaw === 'string' ? slugRaw : undefined

  const label =
    typeof o.label === 'string'
      ? o.label.trim()
      : typeof o.name === 'string'
        ? o.name.trim()
        : undefined

  const latitude = parseCoordinate(o.latitude ?? o.lat)
  const longitude = parseCoordinate(o.longitude ?? o.lng)

  const googlePlaceRaw = o.google_place_id ?? o.googlePlaceId
  const google_place_id =
    googlePlaceRaw === null
      ? null
      : typeof googlePlaceRaw === 'string'
        ? googlePlaceRaw.trim()
        : undefined

  return {
    location_id,
    location_slug,
    slug,
    label: label?.length ? label : undefined,
    latitude,
    longitude,
    google_place_id,
  }
}

function readFlatLocationSlug(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined
  const raw = body[key]
  if (raw === null) return null
  if (typeof raw !== 'string') return undefined
  const slug = raw.trim().toLowerCase()
  return slug.length > 0 ? slug : null
}

function readFlatLocationId(body: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in body)) return undefined
  const raw = body[key]
  if (raw === null) return null
  return normalizeId(raw) ?? undefined
}

function readFlatLocationLabel(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined
  const raw = body[key]
  if (raw === null) return null
  if (typeof raw !== 'string') return undefined
  const label = raw.trim()
  return label.length > 0 ? label : null
}

function readFlatCoordinate(
  body: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in body)) return undefined
  const raw = body[key]
  if (raw === null) return null
  return parseCoordinate(raw) ?? undefined
}

function readFlatGooglePlaceId(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) return undefined
  const raw = body[key]
  if (raw === null) return null
  if (typeof raw !== 'string') return undefined
  const id = raw.trim()
  return id.length > 0 ? id : null
}

function hasGeographicFields(input: UserLocationInput): boolean {
  const label = input.label?.trim()
  const lat = input.latitude
  const lng = input.longitude
  return Boolean(label?.length) && lat != null && lng != null
}

function hasCmsFields(input: UserLocationInput): boolean {
  return (
    normalizeId(input.location_id) != null ||
    normalizeSlug(input.location_slug) != null ||
    normalizeSlug(input.slug) != null
  )
}

/** Merge nested + flat location fields from a request body into profile column updates. */
export async function buildUserLocationProfileChanges(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}

  const nestedCurrent = readLocationInput(body.current_location)
  const nestedHometown = readLocationInput(body.hometown)

  const flatCurrentSlug = readFlatLocationSlug(body, 'current_location_slug')
  const flatCurrentId = readFlatLocationId(body, 'current_location_id')
  const flatHometownSlug = readFlatLocationSlug(body, 'hometown_location_slug')
  const flatHometownId = readFlatLocationId(body, 'hometown_location_id')

  const flatCurrentLabel = readFlatLocationLabel(body, 'current_location_label')
  const flatCurrentLat = readFlatCoordinate(body, 'current_latitude')
  const flatCurrentLng = readFlatCoordinate(body, 'current_longitude')
  const flatCurrentPlaceId = readFlatGooglePlaceId(body, 'current_google_place_id')

  const flatHometownLabel = readFlatLocationLabel(body, 'hometown_location_label')
  const flatHometownLat = readFlatCoordinate(body, 'hometown_latitude')
  const flatHometownLng = readFlatCoordinate(body, 'hometown_longitude')
  const flatHometownPlaceId = readFlatGooglePlaceId(body, 'hometown_google_place_id')

  const currentInput =
    nestedCurrent !== undefined
      ? nestedCurrent
      : flatCurrentSlug !== undefined ||
          flatCurrentId !== undefined ||
          flatCurrentLabel !== undefined ||
          flatCurrentLat !== undefined ||
          flatCurrentLng !== undefined ||
          flatCurrentPlaceId !== undefined
        ? {
            location_slug: flatCurrentSlug ?? undefined,
            location_id: flatCurrentId ?? undefined,
            label: flatCurrentLabel ?? undefined,
            latitude: flatCurrentLat ?? undefined,
            longitude: flatCurrentLng ?? undefined,
            google_place_id: flatCurrentPlaceId ?? undefined,
          }
        : undefined

  const hometownInput =
    nestedHometown !== undefined
      ? nestedHometown
      : flatHometownSlug !== undefined ||
          flatHometownId !== undefined ||
          flatHometownLabel !== undefined ||
          flatHometownLat !== undefined ||
          flatHometownLng !== undefined ||
          flatHometownPlaceId !== undefined
        ? {
            location_slug: flatHometownSlug ?? undefined,
            location_id: flatHometownId ?? undefined,
            label: flatHometownLabel ?? undefined,
            latitude: flatHometownLat ?? undefined,
            longitude: flatHometownLng ?? undefined,
            google_place_id: flatHometownPlaceId ?? undefined,
          }
        : undefined

  if (currentInput !== undefined) {
    if (currentInput === null) {
      Object.assign(out, storedFieldsFromSnapshot(null, 'current'))
    } else {
      const resolved = await resolveProfileLocationInput(currentInput)
      if (!resolved) throw new Error('Invalid current_location — provide label with coordinates')
      Object.assign(out, storedFieldsFromSnapshot(resolved, 'current'))
    }
  }

  if (hometownInput !== undefined) {
    if (hometownInput === null) {
      Object.assign(out, storedFieldsFromSnapshot(null, 'hometown'))
    } else {
      const resolved = await resolveProfileLocationInput(hometownInput)
      if (!resolved) throw new Error('Invalid hometown — provide label with coordinates')
      Object.assign(out, storedFieldsFromSnapshot(resolved, 'hometown'))
    }
  }

  if (Object.keys(out).length > 0) {
    out.location_profile_updated_at = new Date().toISOString()
  }

  return out
}

function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const slug = raw.trim().toLowerCase()
  return slug.length > 0 ? slug : null
}

function normalizeId(raw: unknown): number | null {
  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) return null
  return Math.floor(id)
}

function parseCoordinate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function toSnapshot(row: DbLocationRow): UserLocationSnapshot {
  const lat = row.latitude != null ? Number(row.latitude) : null
  const lng = row.longitude != null ? Number(row.longitude) : null
  return {
    location_id: row.id,
    slug: row.slug.trim().toLowerCase(),
    label: row.name.trim(),
    type: row.type,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    google_place_id: null,
  }
}

async function fetchLocationBySlug(slug: string): Promise<UserLocationSnapshot | null> {
  const result = await hasuraQuery<{ restaurant_locations: DbLocationRow[] }>(
    GET_LOCATION_BY_SLUG,
    { slug: slug.trim().toLowerCase() },
  )
  const row = result.data?.restaurant_locations?.[0]
  return row ? toSnapshot(row) : null
}

async function fetchLocationById(id: number): Promise<UserLocationSnapshot | null> {
  const result = await hasuraQuery<{ restaurant_locations: DbLocationRow[] }>(
    GET_LOCATION_BY_ID,
    { id },
  )
  const row = result.data?.restaurant_locations?.[0]
  return row ? toSnapshot(row) : null
}

/**
 * Resolve CMS location from slug or id. Prefers id when both are supplied.
 */
export async function resolveUserLocationInput(
  input: UserLocationInput | null | undefined,
): Promise<UserLocationSnapshot | null> {
  if (!input) return null

  const id = normalizeId(input.location_id)
  if (id != null) {
    const byId = await fetchLocationById(id)
    if (byId) return byId
  }

  const slug = normalizeSlug(input.location_slug) ?? normalizeSlug(input.slug)
  if (slug) {
    return fetchLocationBySlug(slug)
  }

  return null
}

/**
 * Accept free-form geographic places (label + lat/lng) or legacy CMS slug/id.
 * When geographic fields are present, CMS link is optional.
 */
async function resolveProfileLocationInput(
  input: UserLocationInput,
): Promise<UserLocationSnapshot | null> {
  if (hasGeographicFields(input)) {
    const cms = hasCmsFields(input) ? await resolveUserLocationInput(input) : null
    const lat = input.latitude!
    const lng = input.longitude!
    const label = input.label!.trim()
    const googlePlaceId = input.google_place_id?.trim() || null

    return {
      location_id: cms?.location_id ?? null,
      slug: cms?.slug ?? null,
      label: cms?.label ?? label,
      type: cms?.type ?? 'city',
      latitude: lat,
      longitude: lng,
      google_place_id: googlePlaceId,
    }
  }

  return resolveUserLocationInput(input)
}

/** DB columns for one of current / hometown on user_profiles. */
export function storedFieldsFromSnapshot(
  snapshot: UserLocationSnapshot | null,
  prefix: 'current' | 'hometown',
): Record<string, number | string | null> {
  if (!snapshot) {
    return {
      [`${prefix}_location_id`]: null,
      [`${prefix}_location_slug`]: null,
      [`${prefix}_latitude`]: null,
      [`${prefix}_longitude`]: null,
      [`${prefix}_location_label`]: null,
      [`${prefix}_google_place_id`]: null,
    }
  }

  return {
    [`${prefix}_location_id`]: snapshot.location_id,
    [`${prefix}_location_slug`]: snapshot.slug,
    [`${prefix}_latitude`]: snapshot.latitude,
    [`${prefix}_longitude`]: snapshot.longitude,
    [`${prefix}_location_label`]: snapshot.label,
    [`${prefix}_google_place_id`]: snapshot.google_place_id ?? null,
  }
}

function slugToLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function snapshotFromProfileRow(
  row: Record<string, unknown>,
  prefix: 'current' | 'hometown',
): UserLocationSnapshot | null {
  const slugRaw = row[`${prefix}_location_slug`]
  const idRaw = row[`${prefix}_location_id`]
  const latRaw = row[`${prefix}_latitude`]
  const lngRaw = row[`${prefix}_longitude`]
  const labelRaw = row[`${prefix}_location_label`]
  const placeIdRaw = row[`${prefix}_google_place_id`]

  const slug = normalizeSlug(slugRaw)
  const locationId = normalizeId(idRaw)
  const lat = latRaw != null ? Number(latRaw) : null
  const lng = lngRaw != null ? Number(lngRaw) : null
  const labelFromColumn = typeof labelRaw === 'string' ? labelRaw.trim() : ''
  const googlePlaceId = typeof placeIdRaw === 'string' ? placeIdRaw.trim() : null

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng)
  const label = labelFromColumn || (slug ? slugToLabel(slug) : '')

  if (!label && !slug && locationId == null && !hasCoords && !googlePlaceId) {
    return null
  }

  return {
    location_id: locationId,
    slug,
    label: label || slug || 'Unknown',
    type: 'city',
    latitude: hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    google_place_id: googlePlaceId?.length ? googlePlaceId : null,
  }
}

import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_LOCATIONS = `
  query GetActiveLocations {
    restaurant_locations(
      where: { is_active: { _eq: true } }
      order_by: [{ display_order: asc }, { name: asc }]
    ) {
      id name slug type short_label flag_url currency timezone latitude longitude parent_id display_order
    }
  }
`

interface DbLocation {
  id: number
  name: string
  slug: string
  type: 'country' | 'city'
  short_label: string | null
  flag_url: string | null
  currency: string | null
  timezone: string | null
  latitude: number | null
  longitude: number | null
  parent_id: number | null
  display_order: number
}

interface CityNode {
  key: string
  label: string
  shortLabel: string
  flag: string
  currency: string
  timezone: string
  type: 'city'
  parentKey: string
  coordinates: { lat: number; lng: number }
}

interface CountryNode {
  key: string
  label: string
  shortLabel: string
  flag: string
  currency: string
  timezone: string
  type: 'country'
  cities: CityNode[]
}

function buildHierarchy(rows: DbLocation[]): { countries: CountryNode[] } {
  const countries = rows.filter(r => r.type === 'country')
  const cities = rows.filter(r => r.type === 'city')
  const countryMap = new Map<number, CountryNode>()

  const countryList = countries.map(c => {
    const country: CountryNode = {
      key: c.slug,
      label: c.name,
      shortLabel: c.short_label ?? c.slug.toUpperCase().slice(0, 3),
      flag: c.flag_url ?? `https://flagcdn.com/${(c.short_label ?? 'un').toLowerCase()}.svg`,
      currency: c.currency ?? 'USD',
      timezone: c.timezone ?? 'UTC',
      type: 'country',
      cities: [],
    }
    countryMap.set(c.id, country)
    return country
  })

  for (const city of cities) {
    if (city.parent_id === null) continue
    const parent = countryMap.get(city.parent_id)
    if (!parent) continue
    parent.cities.push({
      key: city.slug,
      label: city.name,
      shortLabel: city.short_label ?? city.slug.toUpperCase().slice(0, 3),
      flag: city.flag_url ?? parent.flag,
      currency: city.currency ?? parent.currency,
      timezone: city.timezone ?? parent.timezone,
      type: 'city',
      parentKey: parent.key,
      coordinates: city.latitude !== null && city.longitude !== null
        ? { lat: Number(city.latitude), lng: Number(city.longitude) }
        : { lat: 0, lng: 0 },
    })
  }

  return { countries: countryList }
}

export default async (_req: Request, res: Response): Promise<void> => {
  try {
    type LocationsResult = { restaurant_locations: DbLocation[] }
    const result = await hasuraQuery<LocationsResult>(GET_LOCATIONS)

    if (result.errors?.length) {
      console.error('[locations/get-locations]', result.errors)
      return fail(res, 'Failed to fetch locations', 500)
    }

    const rows = result.data?.restaurant_locations ?? []
    const hierarchy = buildHierarchy(rows)
    const flatList = [
      ...hierarchy.countries,
      ...hierarchy.countries.flatMap((c: CountryNode) => c.cities),
    ]

    ok(res, { hierarchy, flatList })
  } catch (error) {
    console.error('[locations/get-locations]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

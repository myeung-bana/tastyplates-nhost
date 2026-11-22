/**
 * Loads the Rating Model v3 review pool from Hasura. Pure scoring lives in `reviewPool.ts`.
 *
 * Every query goes through `hasuraAdmin`, which throws on GraphQL errors: a failed lookup must
 * never silently drop reviewers (the v2 palate rebuild did, by querying `user_profiles.id`).
 */
import { hasuraAdmin } from './hasura'
import {
  buildCuisineTaxonomy,
  buildPoolEntries,
  type CuisineRow,
  type CuisineTaxonomy,
  type NativeReviewRow,
  type PoolEntry,
  type ScrapedReviewRow,
} from './reviewPool'

const PAGE_SIZE = 1000

const GET_CUISINES = `
  query ReviewPoolCuisines {
    restaurant_cuisines(order_by: { id: asc }) { id slug name parent_id }
  }
`

const NATIVE_FIELDS =
  'id restaurant_uuid rating status author_id palates deleted_at parent_review_id created_at'
const SCRAPED_FIELDS =
  'id restaurant_uuid rating is_flagged author_palates source_author_id source_author_name reviewed_at ingested_at'

// Status rule mirrors EXCLUDED_NATIVE_STATUSES; buildPoolEntries re-checks every row.
const NATIVE_WHERE = `{
  deleted_at: { _is_null: true }
  parent_review_id: { _is_null: true }
  _or: [{ status: { _is_null: true } }, { status: { _nin: ["draft", "rejected"] } }]
  restaurant_uuid: $restaurantFilter
}`
const SCRAPED_WHERE = `{
  is_flagged: { _eq: false }
  restaurant_uuid: $restaurantFilter
}`

const GET_NATIVE_PAGE = `
  query ReviewPoolNative($restaurantFilter: uuid_comparison_exp!, $limit: Int!, $offset: Int!) {
    restaurant_reviews(where: ${NATIVE_WHERE}, order_by: { id: asc }, limit: $limit, offset: $offset) {
      ${NATIVE_FIELDS}
    }
  }
`

const GET_SCRAPED_PAGE = `
  query ReviewPoolScraped($restaurantFilter: uuid_comparison_exp!, $limit: Int!, $offset: Int!) {
    restaurant_external_reviews(where: ${SCRAPED_WHERE}, order_by: { id: asc }, limit: $limit, offset: $offset) {
      ${SCRAPED_FIELDS}
    }
  }
`

// `user_profiles.user_id` is bpchar in production (see review-enrichment.ts); values are trimmed on read.
const GET_PROFILE_PALATES = `
  query ReviewPoolProfiles($userIds: [bpchar!]!) {
    user_profiles(where: { user_id: { _in: $userIds } }) { user_id palates }
  }
`

export async function loadCuisineTaxonomy(): Promise<CuisineTaxonomy> {
  const data = await hasuraAdmin<{ restaurant_cuisines: CuisineRow[] }>(GET_CUISINES)
  return buildCuisineTaxonomy(data.restaurant_cuisines ?? [])
}

async function loadAllPages<T>(
  query: string,
  field: string,
  restaurantFilter: Record<string, unknown>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const data = await hasuraAdmin<Record<string, T[]>>(query, {
      restaurantFilter,
      limit: PAGE_SIZE,
      offset,
    })
    const page = data[field] ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function loadProfilePalates(userIds: string[]): Promise<Map<string, unknown>> {
  const unique = [...new Set(userIds.map((id) => id.trim().toLowerCase()).filter(Boolean))]
  const map = new Map<string, unknown>()
  for (let i = 0; i < unique.length; i += PAGE_SIZE) {
    const data = await hasuraAdmin<{ user_profiles: Array<{ user_id: string; palates: unknown }> }>(
      GET_PROFILE_PALATES,
      { userIds: unique.slice(i, i + PAGE_SIZE) },
    )
    for (const profile of data.user_profiles ?? []) {
      map.set(profile.user_id.trim().toLowerCase(), profile.palates)
    }
  }
  return map
}

/**
 * Load the pool for the given restaurants, or for every restaurant when `restaurantUuids` is
 * omitted. Pass a taxonomy to reuse one already loaded.
 */
export async function loadReviewPool(options?: {
  restaurantUuids?: string[]
  taxonomy?: CuisineTaxonomy
}): Promise<{ entries: PoolEntry[]; taxonomy: CuisineTaxonomy }> {
  const uuids = options?.restaurantUuids
    ? [...new Set(options.restaurantUuids.map((u) => u.trim()).filter(Boolean))]
    : null
  if (uuids && uuids.length === 0) {
    return { entries: [], taxonomy: options?.taxonomy ?? (await loadCuisineTaxonomy()) }
  }

  const restaurantFilter = uuids ? { _in: uuids } : { _is_null: false }

  const [taxonomy, native, scraped] = await Promise.all([
    options?.taxonomy ? Promise.resolve(options.taxonomy) : loadCuisineTaxonomy(),
    loadAllPages<NativeReviewRow>(GET_NATIVE_PAGE, 'restaurant_reviews', restaurantFilter),
    loadAllPages<ScrapedReviewRow>(GET_SCRAPED_PAGE, 'restaurant_external_reviews', restaurantFilter),
  ])

  const profilePalatesByUserId = await loadProfilePalates(
    native.map((row) => row.author_id ?? '').filter(Boolean),
  )

  return {
    entries: buildPoolEntries({ native, scraped, profilePalatesByUserId, taxonomy }),
    taxonomy,
  }
}

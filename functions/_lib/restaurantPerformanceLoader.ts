/**
 * Loads everything the admin performance dashboard needs for one restaurant, then hands it to the
 * pure `computeRestaurantPerformance`. Read-only.
 */
import { hasuraAdmin } from './hasura'
import { groupPoolByRestaurant, PUBLIC_REVIEW_STATUS_WHERE, resolveRestaurantCuisines } from './reviewPool'
import { loadReviewPool } from './reviewPoolLoader'
import {
  computeRestaurantPerformance,
  type PerformanceRange,
  type RestaurantPerformance,
} from './restaurantPerformance'

const GET_RESTAURANT = `
  query PerformanceRestaurant($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      id uuid title status cuisines address google_place_id
    }
  }
`

const GET_PEERS = `
  query PerformancePeers($where: restaurants_bool_exp!) {
    restaurants(where: $where) { uuid }
  }
`

const GET_ACTIVITY = `
  query PerformanceActivity($uuid: uuid!, $restaurantId: bigint!) {
    native: restaurant_reviews(
      where: {
        restaurant_uuid: { _eq: $uuid }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        ${PUBLIC_REVIEW_STATUS_WHERE}
      }
    ) { created_at recognitions hashtags }
    replies: restaurant_reviews(
      where: {
        restaurant_uuid: { _eq: $uuid }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: false }
        ${PUBLIC_REVIEW_STATUS_WHERE}
      }
    ) { created_at }
    scraped: restaurant_external_reviews(
      where: { restaurant_uuid: { _eq: $uuid }, is_flagged: { _eq: false } }
    ) { reviewed_at ingested_at palates }
    checkins: user_checkins(where: { restaurant_uuid: { _eq: $uuid } }) { checked_in_at }
    list_adds: recommended_restaurant_list_items(where: { restaurant_uuid: { _eq: $uuid } }) { created_at }
    saves: user_place_collections(where: { tastyplates_restaurant_uuid: { _eq: $uuid } }) { created_at }
    likes: restaurant_review_likes(
      where: { restaurant_review: { restaurant_uuid: { _eq: $uuid }, deleted_at: { _is_null: true } } }
    ) { created_at }
    summary: restaurant_rating_summary(where: { restaurant_id: { _eq: $restaurantId } }, limit: 1) {
      overall_rating_avg overall_review_count updated_at
    }
  }
`

type RestaurantRow = {
  id: number
  uuid: string
  title: string
  status: string
  cuisines: unknown
  address: { city?: string } | null
  google_place_id: string | null
}

type ActivityResult = {
  native: Array<{ created_at: string | null; recognitions: unknown; hashtags: unknown }>
  replies: Array<{ created_at: string | null }>
  scraped: Array<{ reviewed_at: string | null; ingested_at: string | null; palates: unknown }>
  checkins: Array<{ checked_in_at: string | null }>
  list_adds: Array<{ created_at: string | null }>
  saves: Array<{ created_at: string | null }>
  likes: Array<{ created_at: string | null }>
  summary: Array<{ overall_rating_avg: number | null; overall_review_count: number; updated_at: string | null }>
}

export async function loadRestaurantPerformance(
  restaurantUuid: string,
  range: PerformanceRange,
  now = new Date(),
): Promise<RestaurantPerformance | null> {
  const uuid = restaurantUuid.trim()
  const restaurantData = await hasuraAdmin<{ restaurants: RestaurantRow[] }>(GET_RESTAURANT, { uuid })
  const restaurant = restaurantData.restaurants?.[0]
  if (!restaurant) return null

  const pool = await loadReviewPool({ restaurantUuids: [uuid] })
  const cuisines = resolveRestaurantCuisines(restaurant.cuisines, pool.taxonomy)

  // Peers: published restaurants sharing the primary cuisine, in the same city when known.
  let peers: Parameters<typeof computeRestaurantPerformance>[0]['peers'] = null
  const primaryCuisineId = [...cuisines.leafIds][0] ?? [...cuisines.regionIds][0]
  if (primaryCuisineId != null) {
    const cuisine = pool.taxonomy.byId.get(primaryCuisineId)
    const city = restaurant.address?.city?.trim()
    const where: Record<string, unknown> = {
      status: { _eq: 'publish' },
      cuisines: { _contains: [{ id: primaryCuisineId }] },
      ...(city ? { address: { _contains: { city } } } : {}),
    }
    const peerData = await hasuraAdmin<{ restaurants: Array<{ uuid: string }> }>(GET_PEERS, { where })
    const peerUuids = [...new Set([uuid, ...peerData.restaurants.map((r) => r.uuid)])]
    const peerPool = await loadReviewPool({ restaurantUuids: peerUuids, taxonomy: pool.taxonomy })
    const byUuid = groupPoolByRestaurant(peerPool.entries)
    for (const peerUuid of peerUuids) if (!byUuid.has(peerUuid)) byUuid.set(peerUuid, [])
    peers = {
      cuisineName: cuisine?.name ?? 'Same cuisine',
      scope: city ?? 'all cities',
      entriesByUuid: byUuid,
    }
  }

  const activity = await hasuraAdmin<ActivityResult>(GET_ACTIVITY, { uuid, restaurantId: restaurant.id })
  const summary = activity.summary?.[0]

  return computeRestaurantPerformance({
    now,
    range,
    restaurantUuid: uuid,
    hasGooglePlace: Boolean(restaurant.google_place_id?.trim()),
    entries: pool.entries,
    restaurantCuisines: cuisines,
    taxonomy: pool.taxonomy,
    peers,
    nativeExtras: activity.native ?? [],
    scrapedTaste: (activity.scraped ?? []).map((r) => ({ at: r.reviewed_at ?? r.ingested_at, tags: r.palates })),
    engagement: {
      checkins: (activity.checkins ?? []).map((r) => r.checked_in_at),
      listAdds: (activity.list_adds ?? []).map((r) => r.created_at),
      saves: (activity.saves ?? []).map((r) => r.created_at),
      likes: (activity.likes ?? []).map((r) => r.created_at),
      replies: (activity.replies ?? []).map((r) => r.created_at),
    },
    storedSummary: summary
      ? {
          overall_avg: summary.overall_rating_avg != null ? Number(summary.overall_rating_avg) : null,
          overall_count: summary.overall_review_count,
          updated_at: summary.updated_at,
        }
      : null,
  })
}

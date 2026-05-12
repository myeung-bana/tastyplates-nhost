import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import { hasuraQuery, hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_ALL_RESTAURANT_UUIDS = `
  query GetAllRestaurantUuids {
    restaurants(where: { status: { _eq: "publish" } }) { uuid }
  }
`

const GET_REVIEW_STATS_FOR_REBUILD = `
  query GetReviewStatsForRebuild($restaurantUuid: uuid!) {
    restaurant_reviews_aggregate(
      where: { restaurant_uuid: { _eq: $restaurantUuid } deleted_at: { _is_null: true } status: { _eq: "approved" } parent_review_id: { _is_null: true } }
    ) { aggregate { count avg { rating } } }
  }
`

const UPSERT_RATING_SUMMARY = `
  mutation UpsertRatingSummary($restaurantUuid: uuid!, $avg: numeric, $count: Int!) {
    insert_restaurant_rating_summary_one(
      object: { restaurant_uuid: $restaurantUuid overall_rating_avg: $avg overall_review_count: $count updated_at: "now()" }
      on_conflict: { constraint: restaurant_rating_summary_restaurant_uuid_key update_columns: [overall_rating_avg overall_review_count updated_at] }
    ) { restaurant_uuid }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    type UuidsResult = { restaurants: Array<{ uuid: string }> }
    const uuidsResult = await hasuraQuery<UuidsResult>(GET_ALL_RESTAURANT_UUIDS)

    if (uuidsResult.errors?.length) {
      console.error('[admin/backfill-rating-summary]', uuidsResult.errors)
      return fail(res, 'Failed to fetch restaurants', 500)
    }

    const uuids = uuidsResult.data?.restaurants.map(r => r.uuid) ?? []
    const total = uuids.length
    let rebuilt = 0
    let failed = 0

    type StatsResult = { restaurant_reviews_aggregate: { aggregate: { count: number; avg: { rating: number | null } | null } } }

    for (const restaurantUuid of uuids) {
      try {
        const statsResult = await hasuraQuery<StatsResult>(GET_REVIEW_STATS_FOR_REBUILD, { restaurantUuid })

        if (statsResult.errors?.length) {
          console.error('[admin/backfill-rating-summary] stats error', statsResult.errors)
          failed++
          continue
        }

        const aggregate = statsResult.data?.restaurant_reviews_aggregate.aggregate
        const count = aggregate?.count ?? 0
        const avg = aggregate?.avg?.rating ?? null

        await hasuraMutation(UPSERT_RATING_SUMMARY, {
          restaurantUuid,
          avg,
          count,
        })

        rebuilt++
      } catch (err) {
        console.error(`[admin/backfill-rating-summary] failed for ${restaurantUuid}`, err)
        failed++
      }
    }

    ok(res, { total, rebuilt, failed })
  } catch (error) {
    console.error('[admin/backfill-rating-summary]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

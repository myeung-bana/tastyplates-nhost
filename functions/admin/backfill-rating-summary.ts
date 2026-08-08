import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import { hasuraQuery } from '../_lib/hasura'
import { rebuildRatingSummary } from '../_lib/rebuildRatingSummary'
import { ok, fail } from '../_lib/respond'

const GET_PUBLISHED_RESTAURANT_UUIDS = `
  query GetPublishedRestaurantUuids {
    restaurants(where: { status: { _eq: "publish" } }) {
      uuid
    }
  }
`

const GET_REVIEWED_RESTAURANT_UUIDS = `
  query GetReviewedRestaurantUuids {
    restaurant_reviews(
      where: {
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
        status: { _eq: "approved" }
      }
      distinct_on: restaurant_uuid
    ) {
      restaurant_uuid
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const [publishedResult, reviewedResult] = await Promise.all([
      hasuraQuery<{ restaurants: Array<{ uuid: string }> }>(GET_PUBLISHED_RESTAURANT_UUIDS),
      hasuraQuery<{ restaurant_reviews: Array<{ restaurant_uuid: string | null }> }>(
        GET_REVIEWED_RESTAURANT_UUIDS,
      ),
    ])

    if (publishedResult.errors?.length) {
      console.error('[admin/backfill-rating-summary]', publishedResult.errors)
      return fail(res, 'Failed to fetch restaurants', 500)
    }
    if (reviewedResult.errors?.length) {
      console.error('[admin/backfill-rating-summary]', reviewedResult.errors)
      return fail(res, 'Failed to fetch reviewed restaurants', 500)
    }

    const uuids = [
      ...new Set([
        ...(publishedResult.data?.restaurants.map((r) => r.uuid) ?? []),
        ...(reviewedResult.data?.restaurant_reviews
          .map((r) => r.restaurant_uuid?.trim())
          .filter((uuid): uuid is string => Boolean(uuid)) ?? []),
      ]),
    ]

    const total = uuids.length
    let rebuilt = 0
    let failed = 0

    for (const restaurantUuid of uuids) {
      try {
        await rebuildRatingSummary(restaurantUuid)
        rebuilt++
      } catch (err) {
        console.error(`[admin/backfill-rating-summary] failed for ${restaurantUuid}`, err)
        failed++
      }
    }

    let externalRebuilt = 0
    try {
      const { rebuildAllExternalReviewSummaries } = await import('../_lib/rebuildExternalReviewSummary')
      externalRebuilt = await rebuildAllExternalReviewSummaries()
    } catch (err) {
      console.warn('[admin/backfill-rating-summary] external summary backfill skipped', err)
    }

    ok(res, { total, rebuilt, failed, external_rebuilt: externalRebuilt })
  } catch (error) {
    console.error('[admin/backfill-rating-summary]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

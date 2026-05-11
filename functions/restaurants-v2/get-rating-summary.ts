import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_RATING_SUMMARY_BY_RESTAURANT_UUID = `
  query GetRatingSummaryByRestaurantUuid($uuid: uuid!) {
    restaurant_rating_summary(where: { restaurant: { uuid: { _eq: $uuid } } } limit: 1) {
      restaurant_id overall_rating_avg overall_review_count authentic_rating_avg authentic_review_count
      authentic_rating_weighted updated_at
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('uuid')

    if (!uuid) return fail(res, 'Missing required param: uuid', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    type Result = {
      restaurant_rating_summary: Array<{
        restaurant_id: number
        overall_rating_avg: number | null
        overall_review_count: number
        authentic_rating_avg: number | null
        authentic_review_count: number
        authentic_rating_weighted: number | null
        updated_at: string
      }>
    }

    const result = await hasuraQuery<Result>(GET_RATING_SUMMARY_BY_RESTAURANT_UUID, { uuid })

    if (result.errors?.length) {
      console.error('[restaurants-v2/get-rating-summary]', result.errors)
      return fail(res, 'Failed to fetch rating summary', 500)
    }

    ok(res, result.data?.restaurant_rating_summary?.[0] ?? null)
  } catch (error) {
    console.error('[restaurants-v2/get-rating-summary]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

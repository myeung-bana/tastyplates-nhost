import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_AUTHENTIC_STATS = `
  query GetAuthenticStats {
    restaurant_rating_summary(where: { authentic_rating_avg: { _is_null: false } }) {
      restaurant_id authentic_rating_avg authentic_review_count authentic_rating_weighted
    }
  }
`

export default async (_req: Request, res: Response): Promise<void> => {
  try {
    type Result = {
      restaurant_rating_summary: Array<{
        restaurant_id: number
        authentic_rating_avg: number | null
        authentic_review_count: number
        authentic_rating_weighted: number | null
      }>
    }

    const result = await hasuraQuery<Result>(GET_AUTHENTIC_STATS)

    if (result.errors?.length) {
      console.error('[restaurants-v2/get-authentic-stats]', result.errors)
      return fail(res, 'Failed to fetch authentic stats', 500)
    }

    ok(res, result.data?.restaurant_rating_summary ?? [])
  } catch (error) {
    console.error('[restaurants-v2/get-authentic-stats]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

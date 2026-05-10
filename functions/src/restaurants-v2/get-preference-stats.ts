import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_PREFERENCE_STATS = `
  query GetPreferenceStats($where: restaurant_cuisine_rating_summary_bool_exp) {
    restaurant_cuisine_rating_summary(where: $where limit: 500) {
      restaurant_id cuisine_id preference_rating_avg preference_review_count
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const palate_slug = url.searchParams.get('palate_slug') ?? undefined
    const palate_id = url.searchParams.get('palate_id') ?? undefined

    const conditions: Record<string, unknown>[] = []

    if (palate_slug) {
      conditions.push({ cuisine: { slug: { _eq: palate_slug } } })
    } else if (palate_id) {
      const id = parseInt(palate_id)
      if (!isNaN(id)) conditions.push({ cuisine_id: { _eq: id } })
    }

    const where = conditions.length > 0 ? { _and: conditions } : undefined

    type Result = {
      restaurant_cuisine_rating_summary: Array<{
        restaurant_id: number
        cuisine_id: number
        preference_rating_avg: number | null
        preference_review_count: number
      }>
    }

    const result = await hasuraQuery<Result>(GET_PREFERENCE_STATS, { where })

    if (result.errors?.length) {
      console.error('[restaurants-v2/get-preference-stats]', result.errors)
      return fail(res, 'Failed to fetch preference stats', 500)
    }

    ok(res, result.data?.restaurant_cuisine_rating_summary ?? [])
  } catch (error) {
    console.error('[restaurants-v2/get-preference-stats]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

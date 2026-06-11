import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { aggregatePreferenceStatsByPalates } from '../_lib/preference-stats-aggregate'
import { ok, fail } from '../_lib/respond'

const GET_PREFERENCE_STATS_SUMMARY = `
  query GetPreferenceStats($where: restaurant_cuisine_rating_summary_bool_exp) {
    restaurant_cuisine_rating_summary(where: $where limit: 500) {
      restaurant_id cuisine_id preference_rating_avg preference_review_count
    }
  }
`

function parsePalatesParam(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))]
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const palatesParam = url.searchParams.get('palates')
    const palate_slug = url.searchParams.get('palate_slug') ?? undefined
    const palate_id = url.searchParams.get('palate_id') ?? undefined

    const palatesFromQuery = parsePalatesParam(palatesParam)
    const palates =
      palatesFromQuery.length > 0
        ? palatesFromQuery
        : palate_slug?.trim()
          ? [palate_slug.trim().toLowerCase()]
          : []

    if (palates.length > 0) {
      const stats = await aggregatePreferenceStatsByPalates(palates)
      return ok(res, stats)
    }

    // Legacy: summary table lookup by cuisine id (no slug expansion).
    const conditions: Record<string, unknown>[] = []
    if (palate_id) {
      const id = parseInt(palate_id)
      if (!isNaN(id)) conditions.push({ cuisine_id: { _eq: id } })
    }

    if (conditions.length === 0) {
      return ok(res, {})
    }

    const where = { _and: conditions }

    type Result = {
      restaurant_cuisine_rating_summary: Array<{
        restaurant_id: number
        cuisine_id: number
        preference_rating_avg: number | null
        preference_review_count: number
      }>
    }

    const result = await hasuraQuery<Result>(GET_PREFERENCE_STATS_SUMMARY, { where })

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

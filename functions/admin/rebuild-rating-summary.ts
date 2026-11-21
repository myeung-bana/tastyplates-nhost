/**
 * POST `admin/rebuild-rating-summary`
 * Header: x-admin-secret
 * Body: `{ restaurant_uuid: uuid, dry_run?: boolean }`
 *
 * Rating Model v3 — recompute Overall + Authentic for one restaurant from the review pool
 * (native × 2 + scraped × 1, no Google aggregate), and schedule both palate-row rebuilds.
 * `dry_run: true` computes and returns the scores without writing anything.
 */
import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import { computeRatingSummary, rebuildRatingSummary } from '../_lib/rebuildRatingSummary'
import type { PoolScore } from '../_lib/reviewPool'
import { ok, fail } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function present(score: PoolScore) {
  return {
    avg: score.display_avg,
    ranking_value: score.ranking_value,
    review_count: score.review_count,
    native_count: score.native_count,
    native_avg: score.native_avg,
    scraped_count: score.scraped_count,
    scraped_avg: score.scraped_avg,
    total_weight: score.total_weight,
  }
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const body = (req.body ?? {}) as { restaurant_uuid?: string; dry_run?: boolean }
    const uuid = body.restaurant_uuid?.trim()
    if (!uuid) return fail(res, 'restaurant_uuid is required', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    const dryRun = body.dry_run === true
    const result = dryRun ? await computeRatingSummary(uuid) : await rebuildRatingSummary(uuid)
    if (!result) return fail(res, 'Restaurant not found', 404)

    ok(res, {
      restaurant_uuid: uuid,
      restaurant_id: result.restaurant_id,
      dry_run: dryRun,
      overall: present(result.overall),
      authentic: present(result.authentic),
    })
  } catch (error) {
    console.error('[admin/rebuild-rating-summary]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

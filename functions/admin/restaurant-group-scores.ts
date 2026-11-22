/**
 * GET `admin/restaurant-group-scores?restaurant_uuid=`
 * Auth: admin Bearer / MCP key / x-admin-secret.
 *
 * Every active lens group scored at one restaurant, live from its Rating Model v3 review pool:
 * pooled score (the group score), balanced score, per-member breakdown and unlock state.
 * Spec: documentation/ratings/palate-groups.md §4.3 (workspace root).
 */
import type { Request, Response } from 'express'
import { resolveAdminApiAuth } from '../_lib/admin-api-auth'
import { fail, ok } from '../_lib/respond'
import { getRestaurantGroupScores } from '../_lib/reviewerGroupsStore'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAdminApiAuth(req, res)
    if (!auth) return

    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('restaurant_uuid')?.trim() ?? ''
    if (!uuid) return fail(res, 'restaurant_uuid is required', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    ok(res, await getRestaurantGroupScores(uuid))
  } catch (error) {
    console.error('[admin/restaurant-group-scores]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

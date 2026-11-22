/**
 * GET `admin/restaurant-performance?restaurant_uuid=&range=30d|90d|1y|all`
 * Auth: admin Bearer / MCP key / x-admin-secret.
 *
 * Admin performance dashboard for one restaurant: KPIs with change over the range, peer rank,
 * score trend, review volume by source, rating distribution, palate fit, review signals,
 * engagement and data-health checks. All scores come from the Rating Model v3 review pool.
 */
import type { Request, Response } from 'express'
import { resolveAdminApiAuth } from '../_lib/admin-api-auth'
import { PERFORMANCE_RANGES, type PerformanceRange } from '../_lib/restaurantPerformance'
import { loadRestaurantPerformance } from '../_lib/restaurantPerformanceLoader'
import { fail, ok } from '../_lib/respond'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAdminApiAuth(req, res)
    if (!auth) return

    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('restaurant_uuid')?.trim() ?? ''
    if (!uuid) return fail(res, 'restaurant_uuid is required', 400)
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Invalid UUID format', 400)

    const rangeParam = url.searchParams.get('range') ?? '90d'
    if (!PERFORMANCE_RANGES.includes(rangeParam as PerformanceRange)) {
      return fail(res, `range must be one of ${PERFORMANCE_RANGES.join(', ')}`, 400)
    }

    const data = await loadRestaurantPerformance(uuid, rangeParam as PerformanceRange)
    if (!data) return fail(res, 'Restaurant not found', 404)
    ok(res, data)
  } catch (error) {
    console.error('[admin/restaurant-performance]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

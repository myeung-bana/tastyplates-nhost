import type { Request, Response } from 'express'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { ok, fail } from '../_lib/respond'
import { loadReadingGroups, loadRestaurant, loadViewerLeafIds } from '../_lib/restaurantReadingStore'
import { computeRestaurantScores } from '../_lib/restaurantScores'
import { loadCuisineTaxonomy, loadReviewPool } from '../_lib/reviewPoolLoader'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET ?uuid= — restaurant detail scores for the viewer (optional Bearer): Overall, the palate score
 * the backend picked for them, Authentic and Shared. See `_lib/restaurantScores.ts`.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const uuid = url.searchParams.get('uuid')?.trim() ?? ''
    if (!UUID_REGEX.test(uuid)) return fail(res, 'Missing or invalid param: uuid', 400)

    const auth = await resolveOptionalAuth(req, res)
    const taxonomy = await loadCuisineTaxonomy()
    const [restaurant, pool, viewerLeafIds, groups] = await Promise.all([
      loadRestaurant(uuid, taxonomy),
      loadReviewPool({ restaurantUuids: [uuid], taxonomy }),
      auth ? loadViewerLeafIds(auth.userId, taxonomy) : Promise.resolve(null),
      auth ? loadReadingGroups(taxonomy) : Promise.resolve([]),
    ])
    if (!restaurant) return fail(res, 'Restaurant not found', 404)

    ok(
      res,
      computeRestaurantScores({
        entries: pool.entries,
        taxonomy,
        restaurantCuisines: restaurant.cuisines,
        viewerLeafIds,
        groups,
      }),
    )
  } catch (error) {
    console.error('[restaurants-v2/get-restaurant-scores]', error)
    fail(res, 'Internal server error', 500)
  }
}

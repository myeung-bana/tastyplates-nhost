/**
 * GET `admin/get-restaurant-external-data?restaurant_uuid=...`
 * Header: `x-admin-secret`
 */
import type { Request, Response } from 'express'
import { z } from 'zod'

import { ADMIN_SECRET } from '../_lib/env'
import { listExternalDataByRestaurant } from '../_lib/restaurantExternalData'
import { fail, ok } from '../_lib/respond'
import { validate } from '../_lib/validate'

const QuerySchema = z.object({
  restaurant_uuid: z.string().uuid(),
})

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    if (req.method !== 'GET') {
      return fail(res, 'Method not allowed', 405)
    }

    const query = validate(req, res, QuerySchema, 'query')
    if (!query) return

    const rows = await listExternalDataByRestaurant(query.restaurant_uuid)
    ok(res, { restaurant_uuid: query.restaurant_uuid, external_data: rows })
  } catch (error) {
    console.error('[admin/get-restaurant-external-data]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

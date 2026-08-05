import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { getRestaurantByUuid } from '../_lib/admin-restaurant-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
  const url = new URL(req.url, 'http://localhost')
  const uuid = url.searchParams.get('uuid')?.trim()
  if (!uuid) return adminError(res, 'uuid is required', 400)
  const result = await getRestaurantByUuid(uuid)
  if (!result) return adminError(res, 'Restaurant not found', 404)
  res.status(200).json(result)
})

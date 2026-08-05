import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { getExternalData } from '../_lib/admin-external-data-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
  const url = new URL(req.url, 'http://localhost')
  const restaurantUuid = url.searchParams.get('restaurant_uuid')?.trim()
  if (!restaurantUuid) return adminError(res, 'restaurant_uuid is required', 400)
  try {
    const result = await getExternalData(restaurantUuid)
    res.status(200).json(result)
  } catch (error) {
    adminError(res, error instanceof Error ? error.message : 'Failed to fetch external data', 500)
  }
})

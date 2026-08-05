import type { Request, Response } from 'express'

import { adminError, adminSuccess } from '../_lib/admin-api-respond'
import { readJsonBody, withAdminApiAuth } from '../_lib/admin-api-handler'
import { createRestaurant } from '../_lib/admin-restaurant-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'POST') return adminError(res, 'Method not allowed', 405)
  try {
    const result = await createRestaurant(readJsonBody(req))
    adminSuccess(res, result.data, undefined, 201)
  } catch (error) {
    adminError(res, error instanceof Error ? error.message : 'Failed to create restaurant', 400)
  }
})

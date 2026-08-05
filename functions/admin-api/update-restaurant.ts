import type { Request, Response } from 'express'

import { adminError, adminSuccess } from '../_lib/admin-api-respond'
import { readJsonBody, withAdminApiAuth } from '../_lib/admin-api-handler'
import { updateRestaurant } from '../_lib/admin-restaurant-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return adminError(res, 'Method not allowed', 405)
  }
  try {
    const result = await updateRestaurant(readJsonBody(req))
    adminSuccess(res, result.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update restaurant'
    const status = message.includes('not found') ? 404 : 400
    adminError(res, message, status)
  }
})

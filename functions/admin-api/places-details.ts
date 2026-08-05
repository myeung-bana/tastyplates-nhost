import type { Request, Response } from 'express'

import { adminError, adminSuccess } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { placesDetails } from '../_lib/admin-restaurant-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
  try {
    const url = new URL(req.url, 'http://localhost')
    const result = await placesDetails(url.searchParams)
    adminSuccess(res, result.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Place details failed'
    const status = message.includes('not found') ? 404 : 400
    adminError(res, message, status)
  }
})

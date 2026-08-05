import type { Request, Response } from 'express'

import { adminError, adminSuccess } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { placesSearch } from '../_lib/admin-restaurant-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
  try {
    const url = new URL(req.url, 'http://localhost')
    const result = await placesSearch(url.searchParams)
    adminSuccess(res, result.data)
  } catch (error) {
    adminError(res, error instanceof Error ? error.message : 'Places search failed', 400)
  }
})

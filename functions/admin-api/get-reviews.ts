import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { listReviews } from '../_lib/admin-review-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
  const url = new URL(req.url, 'http://localhost')
  const result = await listReviews(url.searchParams)
  res.status(200).json(result)
})

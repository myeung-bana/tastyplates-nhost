import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { getReviewById } from '../_lib/admin-review-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
  const url = new URL(req.url, 'http://localhost')
  const id = url.searchParams.get('id')?.trim()
  if (!id) return adminError(res, 'id is required', 400)
  const result = await getReviewById(id)
  if (!result) return adminError(res, 'Review not found', 404)
  res.status(200).json({ success: true, ...result })
})

import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { readJsonBody, withAdminApiAuth } from '../_lib/admin-api-handler'
import { triggerExternalScrape } from '../_lib/admin-external-data-handlers'

export default withAdminApiAuth(async (req: Request, res: Response) => {
  if (req.method !== 'POST') return adminError(res, 'Method not allowed', 405)
  const body = readJsonBody<{ restaurant_uuid?: string; source?: string }>(req)
  const restaurantUuid = typeof body.restaurant_uuid === 'string' ? body.restaurant_uuid.trim() : ''
  if (!restaurantUuid) return adminError(res, 'restaurant_uuid is required', 400)

  const source =
    body.source === 'yelp' || body.source === 'tripadvisor' || body.source === 'google_maps'
      ? body.source
      : 'google_maps'

  try {
    const result = await triggerExternalScrape({ restaurant_uuid: restaurantUuid, source })
    res.status(200).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to trigger scrape'
    const status = message.includes('not configured') ? 503 : message.includes('not found') ? 404 : 502
    adminError(res, message, status)
  }
})

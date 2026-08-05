import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { getMcpHealth } from '../_lib/admin-mcp-handlers'

/** Public health check — no auth required. */
export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET') {
    adminError(res, 'Method not allowed', 405)
    return
  }
  res.status(200).json(getMcpHealth())
}

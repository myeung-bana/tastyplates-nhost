import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { getMcpConfig } from '../_lib/admin-mcp-handlers'

export default withAdminApiAuth(
  async (req: Request, res: Response) => {
    if (req.method !== 'GET') return adminError(res, 'Method not allowed', 405)
    res.status(200).json(getMcpConfig())
  },
  { sessionOnly: true },
)

import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { withAdminApiAuth } from '../_lib/admin-api-handler'
import { revokeMcpKey } from '../_lib/admin-mcp-handlers'

export default withAdminApiAuth(
  async (req: Request, res: Response, auth) => {
    if (req.method !== 'DELETE') return adminError(res, 'Method not allowed', 405)

    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')?.trim()
    if (!id) return adminError(res, 'id is required', 400)

    try {
      const result = await revokeMcpKey(auth.userId, id)
      if (!result) return adminError(res, 'Key not found', 404)
      res.status(200).json(result)
    } catch (error) {
      adminError(res, error instanceof Error ? error.message : 'Failed to revoke key', 500)
    }
  },
  { sessionOnly: true },
)

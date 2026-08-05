import type { Request, Response } from 'express'

import { adminError } from '../_lib/admin-api-respond'
import { readJsonBody, withAdminApiAuth } from '../_lib/admin-api-handler'
import { createMcpKey, listMcpKeys } from '../_lib/admin-mcp-handlers'

export default withAdminApiAuth(
  async (req: Request, res: Response, auth) => {
    if (req.method === 'GET') {
      try {
        const result = await listMcpKeys(auth.userId)
        res.status(200).json(result)
      } catch (error) {
        adminError(res, error instanceof Error ? error.message : 'Failed to list keys', 500)
      }
      return
    }

    if (req.method === 'POST') {
      try {
        const result = await createMcpKey(auth.userId, readJsonBody(req))
        res.status(201).json(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create key'
        const status = message.includes('Maximum') ? 400 : 500
        adminError(res, message, status)
      }
      return
    }

    adminError(res, 'Method not allowed', 405)
  },
  { sessionOnly: true },
)

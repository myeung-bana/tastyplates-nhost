import type { Request, Response } from 'express'
import process from 'node:process'
import { ok } from './_lib/respond'

export default (_req: Request, res: Response): void => {
  ok(res, {
    status: 'ok',
    service: 'tastyplates-functions',
    node: process.version,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  })
}

import type { Request, Response } from 'express'

export default (_req: Request, res: Response): void => {
  res.status(410).json({ ok: false, error: 'Firebase UUID lookup is deprecated. Use UUID or username instead.' })
}

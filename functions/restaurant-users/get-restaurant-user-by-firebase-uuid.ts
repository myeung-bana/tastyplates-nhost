import type { Request, Response } from 'express'
import { fail } from '../_lib/respond'

export default (_req: Request, res: Response): void => {
  fail(
    res,
    'Removed. Use get-restaurant-user-by-id or get-restaurant-user-by-username instead.',
    410,
  )
}

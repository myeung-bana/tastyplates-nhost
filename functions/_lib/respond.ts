import type { Response } from 'express'

/** Standard success envelope */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data })
}

/** Standard error envelope */
export function fail(
  res: Response,
  message: string,
  status = 400,
  details?: unknown,
): void {
  res.status(status).json({ ok: false, error: message, ...(details ? { details } : {}) })
}

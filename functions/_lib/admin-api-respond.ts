import type { Response } from 'express'

/** Portal / MCP compatible JSON envelope (distinct from legacy `{ ok: true }`). */
export function adminSuccess<T>(
  res: Response,
  data: T,
  meta?: Record<string, unknown>,
  status = 200,
): void {
  res.status(status).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
  })
}

export function adminError(
  res: Response,
  message: string,
  status = 400,
  details?: unknown,
): void {
  res.status(status).json({
    success: false,
    error: message,
    ...(details !== undefined ? { details } : {}),
  })
}

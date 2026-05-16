import type { Request, Response } from 'express'
import { ZodSchema, ZodError } from 'zod'
import { fail } from './respond'

/**
 * Validates req.body against a Zod schema.
 * Returns the typed data on success, sends a 422 and returns null on failure.
 *
 * Usage:
 *   const body = validate(req, res, MySchema)
 *   if (!body) return
 */
export function validate<T>(
  req: Request,
  res: Response,
  schema: ZodSchema<T>,
  source: 'body' | 'query' = 'body',
): T | null {
  const result = schema.safeParse(source === 'query' ? req.query : req.body)
  if (!result.success) {
    const issues = (result.error as ZodError).issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }))
    fail(res, 'Validation failed', 422, issues)
    return null
  }
  return result.data
}

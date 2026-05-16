import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { requireAuth, getUserId, type NhostJwtPayload } from './auth'
import { resolveJwtVerifyOptions } from './env'
import { fail } from './respond'

const JWT_VERIFY = resolveJwtVerifyOptions()

export interface AuthContext {
  payload: NhostJwtPayload
  userId: string
}

export async function resolveAuth(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  const payload = await requireAuth(req, res)
  if (!payload) return null
  return { payload, userId: getUserId(payload) }
}

export async function resolveOwnerAuth(
  req: Request,
  res: Response,
  expectedUserId: string,
): Promise<AuthContext | null> {
  const auth = await resolveAuth(req, res)
  if (!auth) return null

  if (auth.userId !== expectedUserId) {
    fail(res, 'Forbidden: you can only access your own resources', 403)
    return null
  }

  return auth
}

/** Optional Bearer — null when absent or invalid; never sends 401. */
export async function resolveOptionalAuth(
  req: Request,
  _res: Response,
): Promise<AuthContext | null> {
  if (!req.headers.authorization?.startsWith('Bearer ')) return null

  const token = req.headers.authorization.split(' ')[1]
  if (!token || !JWT_VERIFY) return null

  try {
    const decoded = jwt.verify(token, JWT_VERIFY.secret, {
      algorithms: JWT_VERIFY.algorithms,
    }) as NhostJwtPayload
    return { payload: decoded, userId: getUserId(decoded) }
  } catch {
    return null
  }
}

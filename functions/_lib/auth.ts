import type { Request, Response } from 'express'
import process from 'node:process'
import jwt from 'jsonwebtoken'
import { fail } from './respond'

export interface NhostJwtPayload {
  sub: string
  'https://hasura.io/jwt/claims': {
    'x-hasura-user-id': string
    'x-hasura-default-role': string
    'x-hasura-allowed-roles': string[]
  }
  iat: number
  exp: number
}

/**
 * Extracts and verifies the Bearer JWT from the Authorization header using
 * the HS256 symmetric secret configured in nhost.toml.
 *
 * Sends 401 and returns null on any failure — callers just `if (!payload) return`.
 */
export function requireAuth(
  req: Request,
  res: Response,
): Promise<NhostJwtPayload | null> {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    fail(res, 'Unauthorized: missing or malformed Authorization header', 401)
    return Promise.resolve(null)
  }

  const token = authHeader.split(' ')[1]
  const secret = process.env.HASURA_GRAPHQL_JWT_SECRET

  if (!secret) {
    fail(res, 'Server misconfiguration: JWT secret not set', 500)
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    jwt.verify(
      token,
      secret,
      { algorithms: ['HS256'] },
      (err, decoded) => {
        if (err) {
          fail(res, `Unauthorized: ${err.message}`, 401)
          resolve(null)
        } else {
          resolve(decoded as NhostJwtPayload)
        }
      },
    )
  })
}

/** Pull the Hasura user ID out of a verified payload — convenience shorthand. */
export function getUserId(payload: NhostJwtPayload): string {
  return payload['https://hasura.io/jwt/claims']['x-hasura-user-id']
}

import type { Request, Response } from 'express'
import { resolveOptionalAuth } from '../_lib/auth-guard'
import { isValidUuid } from '../_lib/review-enrichment'
import {
  listUserReviews,
  PRIVATE_REVIEW_STATUSES,
} from '../_lib/list-user-reviews'
import { ok, fail } from '../_lib/respond'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const userId = url.searchParams.get('user_id')?.trim() ?? ''
    const status = url.searchParams.get('status')?.toLowerCase() ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0

    if (!userId) return fail(res, 'Missing required param: user_id', 400)
    if (!isValidUuid(userId)) return fail(res, 'Invalid UUID format', 400)

    const auth = await resolveOptionalAuth(req, res)
    const authUserId = auth?.userId ?? null
    const hasBearer = Boolean(req.headers.authorization?.startsWith('Bearer '))
    const canReadPrivate = authUserId === userId

    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !hasBearer) {
      return fail(res, 'Unauthorized', 401)
    }
    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !canReadPrivate) {
      return fail(res, 'Forbidden', 403)
    }

    const result = await listUserReviews({
      authorId: userId,
      status,
      limit,
      offset,
      summary: false,
      canReadPrivate,
      enrichRestaurants: false,
      logTag: '[restaurant-users/get-reviews]',
    })

    if (!result.ok) {
      return fail(res, result.error, result.error === 'Invalid status' ? 400 : 500)
    }

    ok(res, result.data)
  } catch (error) {
    console.error('[restaurant-users/get-reviews]', error)
    fail(res, 'Internal server error', 500)
  }
}

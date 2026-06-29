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
    const authorId = url.searchParams.get('author_id')
    const status = url.searchParams.get('status')?.toLowerCase() ?? undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100)
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0
    const summaryParam = url.searchParams.get('summary')
    const summary = summaryParam === '1' || summaryParam === 'true'

    if (!authorId) return fail(res, 'Missing required param: author_id', 400)
    if (!isValidUuid(authorId)) return fail(res, 'Invalid UUID format', 400)

    const auth = await resolveOptionalAuth(req, res)
    const authUserId = auth?.userId ?? null
    const hasBearer = Boolean(req.headers.authorization?.startsWith('Bearer '))
    const canReadPrivate = authUserId === authorId

    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !hasBearer) {
      return fail(res, 'Unauthorized', 401)
    }
    if (status && PRIVATE_REVIEW_STATUSES.has(status) && !canReadPrivate) {
      return fail(res, 'Forbidden', 403)
    }

    const result = await listUserReviews({
      authorId,
      status,
      limit,
      offset,
      summary,
      canReadPrivate,
      enrichRestaurants: false,
      logTag: '[restaurant-reviews/get-user-reviews]',
    })

    if (!result.ok) {
      return fail(res, result.error, result.error === 'Invalid status' ? 400 : 500)
    }

    ok(res, result.data)
  } catch (error) {
    console.error('[restaurant-reviews/get-user-reviews]', error)
    fail(res, 'Internal server error', 500)
  }
}

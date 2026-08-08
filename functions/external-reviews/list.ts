/**
 * GET `external-reviews/list`
 * Auth: admin Bearer / MCP key / x-admin-secret
 */
import type { Request, Response } from 'express'

import { resolveAdminApiAuth } from '../_lib/admin-api-auth'
import {
  buildExternalReviewWhere,
  getExternalReviewById,
  listExternalReviews,
} from '../_lib/externalReviewQueries'
import { UUID_REGEX } from '../_lib/externalReviewTypes'
import { fail, ok } from '../_lib/respond'

function parseLimit(value: string | null, fallback = 20): number {
  const n = parseInt(value ?? '', 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(1, Math.min(n, 100))
}

function parseOffset(value: string | null): number {
  const n = parseInt(value ?? '', 10)
  if (Number.isNaN(n) || n < 0) return 0
  return n
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    if (req.method !== 'GET') {
      return fail(res, 'Method not allowed', 405)
    }

    const auth = await resolveAdminApiAuth(req, res)
    if (!auth) return

    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')?.trim()

    if (id) {
      if (!UUID_REGEX.test(id)) return fail(res, 'Invalid id format', 400)
      const review = await getExternalReviewById(id)
      if (!review) return fail(res, 'External review not found', 404)
      ok(res, { reviews: [review], total: 1 })
      return
    }

    const restaurantUuid = url.searchParams.get('restaurant_uuid')?.trim()
    if (!restaurantUuid) {
      return fail(res, 'restaurant_uuid is required unless id is provided', 400)
    }
    if (!UUID_REGEX.test(restaurantUuid)) {
      return fail(res, 'Invalid restaurant_uuid format', 400)
    }

    const where = buildExternalReviewWhere(url.searchParams)
    const limit = parseLimit(url.searchParams.get('limit'))
    const offset = parseOffset(url.searchParams.get('offset'))

    const { reviews, total } = await listExternalReviews({ where, limit, offset })
    ok(res, { reviews, total })
  } catch (error) {
    console.error('[external-reviews/list]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

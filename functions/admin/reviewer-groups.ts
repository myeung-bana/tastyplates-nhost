/**
 * Reviewer groups (Stage 1: insight lenses). Auth: admin Bearer / MCP key / x-admin-secret.
 *
 * GET  `admin/reviewer-groups?include_inactive=true&id=` → list groups with member cuisine ids
 * POST `admin/reviewer-groups` → create (no id) or update (id) a lens group and replace its members.
 *      Body: { id?, slug?, name, description?, sort_order?, is_active?, member_cuisine_ids: number[] }
 *      Removing a group = { id, is_active: false } (groups are deactivated, never hard-deleted).
 *
 * Spec: documentation/ratings/palate-groups.md §4.4 (workspace root).
 */
import type { Request, Response } from 'express'
import { resolveAdminApiAuth } from '../_lib/admin-api-auth'
import { fail, ok } from '../_lib/respond'
import type { ReviewerGroupInput } from '../_lib/reviewerGroups'
import { listReviewerGroups, saveReviewerGroup } from '../_lib/reviewerGroupsStore'

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAdminApiAuth(req, res)
    if (!auth) return

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost')
      const idParam = url.searchParams.get('id')
      const id = idParam ? Number(idParam) : undefined
      if (idParam && !Number.isInteger(id)) return fail(res, 'Invalid id', 400)
      const groups = await listReviewerGroups({
        includeInactive: url.searchParams.get('include_inactive') !== 'false',
        id,
      })
      if (id != null && groups.length === 0) return fail(res, 'Reviewer group not found', 404)
      return ok(res, { groups })
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as ReviewerGroupInput
      try {
        const group = await saveReviewerGroup(body, auth.userId ?? null)
        return ok(res, { group }, body.id != null ? 200 : 201)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save reviewer group'
        const status = message === 'Reviewer group not found' ? 404 : 400
        return fail(res, message, status)
      }
    }

    return fail(res, 'Method not allowed', 405)
  } catch (error) {
    console.error('[admin/reviewer-groups]', error)
    fail(res, error instanceof Error ? error.message : 'Internal server error', 500)
  }
}

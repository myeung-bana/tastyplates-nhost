import type { Request, Response } from 'express'
import { z } from 'zod'
import { ADMIN_SECRET } from '../_lib/env'
import {
  banUser,
  getReport,
  hideAllContentByUser,
  hideList,
  hideReviewContent,
  resolveReports,
} from '../_lib/contentReports'
import { ok, fail } from '../_lib/respond'

const bodySchema = z.object({
  report_id: z.string().uuid(),
  action: z.enum(['dismiss', 'remove_content', 'ban_user']),
  /** With `ban_user`: also soft-delete every review and comment by the user. */
  remove_all_content: z.boolean().optional(),
  resolution: z.string().trim().max(1000).optional(),
  resolved_by: z.string().trim().max(200).optional(),
})

/**
 * POST `admin/resolve-report`
 * Header `x-admin-secret` required. Resolves the report (and every other open report on the same
 * target) after applying the moderation action:
 * - `dismiss` — no change to content
 * - `remove_content` — hide the review/comment, or unpublish the list (use `ban_user` for profiles)
 * - `ban_user` — disable the content owner's sign-in, end sessions, and remove the reported content
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const parsed = bodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return fail(res, 'Invalid request', 400, parsed.error.flatten())
    const body = parsed.data

    const report = await getReport(body.report_id)
    if (!report) return fail(res, 'Report not found', 404)

    const effects: Record<string, unknown> = {}

    const removeTarget = async () => {
      if (report.target_type === 'review' || report.target_type === 'comment') {
        effects.content_hidden = await hideReviewContent(report.target_id)
      } else if (report.target_type === 'list') {
        effects.list_unpublished = await hideList(report.target_id)
      }
    }

    if (body.action === 'remove_content') {
      if (report.target_type === 'user') {
        return fail(res, 'Profiles cannot be removed on their own; use ban_user', 400)
      }
      await removeTarget()
    } else if (body.action === 'ban_user') {
      if (!report.target_owner_id) return fail(res, 'Report has no content owner to ban', 400)
      effects.user_banned = await banUser(report.target_owner_id)
      await removeTarget()
      if (body.remove_all_content) {
        effects.content_removed_count = await hideAllContentByUser(report.target_owner_id)
      }
    }

    const resolvedCount = await resolveReports({
      reportId: report.id,
      status: body.action === 'dismiss' ? 'dismissed' : 'actioned',
      resolution: body.resolution || body.action,
      resolvedBy: body.resolved_by || 'admin-mcp',
    })

    ok(res, { report_id: report.id, action: body.action, resolved_reports: resolvedCount, ...effects })
  } catch (error) {
    console.error('[admin/resolve-report]', error)
    fail(res, 'Internal server error', 500)
  }
}

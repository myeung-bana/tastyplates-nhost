import type { Request, Response } from 'express'
import { z } from 'zod'
import { resolveAuth } from '../_lib/auth-guard'
import {
  createReport,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  resolveTargetOwner,
} from '../_lib/contentReports'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateReportSchema = z.object({
  target_type: z.enum(REPORT_TARGET_TYPES),
  target_id: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(1000).optional().nullable(),
})

/**
 * POST `reports/create-report`
 * Bearer required. Body: { target_type, target_id, reason, details? }.
 * Re-reporting the same target while a report is open returns the existing report.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const body = validate(req, res, CreateReportSchema)
    if (!body) return

    const ownerId = await resolveTargetOwner(body.target_type, body.target_id)
    if (body.target_type !== 'user' && !ownerId) return fail(res, 'Content not found', 404)
    if (ownerId && ownerId === auth.userId) return fail(res, 'You cannot report your own content', 400)

    const report = await createReport({
      reporterId: auth.userId,
      targetType: body.target_type,
      targetId: body.target_id,
      targetOwnerId: ownerId,
      reason: body.reason,
      details: body.details ?? null,
    })

    ok(res, { report: { id: report.id, status: report.status, created_at: report.created_at } }, 201)
  } catch (error) {
    console.error('[reports/create-report]', error)
    fail(res, 'Failed to submit report', 500)
  }
}

import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import {
  getReportTargetPreview,
  listReports,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type ReportStatus,
  type ReportTargetType,
} from '../_lib/contentReports'
import { ok, fail } from '../_lib/respond'

/**
 * GET `admin/list-reports`
 * Header `x-admin-secret` required. Query: `status` (default `open`, or `all`), `target_type`,
 * `limit` (default 25, max 100), `offset`. Oldest first so the 24h SLA queue drains in order.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'open'
    const status =
      rawStatus === 'all'
        ? undefined
        : (REPORT_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as ReportStatus)
          : null
    if (status === null) return fail(res, `status must be one of all, ${REPORT_STATUSES.join(', ')}`, 400)

    const rawType = typeof req.query.target_type === 'string' ? req.query.target_type : ''
    if (rawType && !(REPORT_TARGET_TYPES as readonly string[]).includes(rawType)) {
      return fail(res, `target_type must be one of ${REPORT_TARGET_TYPES.join(', ')}`, 400)
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const { reports, total } = await listReports({
      status,
      targetType: (rawType || undefined) as ReportTargetType | undefined,
      limit,
      offset,
    })

    const withTargets = await Promise.all(
      reports.map(async (report) => ({
        ...report,
        age_hours: Math.round((Date.now() - new Date(report.created_at).getTime()) / 36e5),
        target: await getReportTargetPreview(report).catch(() => null),
      })),
    )

    ok(res, { reports: withTargets, total, limit, offset })
  } catch (error) {
    console.error('[admin/list-reports]', error)
    fail(res, 'Internal server error', 500)
  }
}

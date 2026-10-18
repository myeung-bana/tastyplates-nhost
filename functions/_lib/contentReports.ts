import { assertUuid, escapeSqlLiteral, hasuraRunSql } from './hasura-run-sql'
import { rebuildRatingSummary } from './rebuildRatingSummary'

export const REPORT_TARGET_TYPES = ['review', 'comment', 'user', 'list'] as const
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'misinformation',
  'off_topic',
  'impersonation',
  'other',
] as const
export const REPORT_STATUSES = ['open', 'actioned', 'dismissed'] as const

export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number]
export type ReportReason = (typeof REPORT_REASONS)[number]
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export interface ContentReport {
  id: string
  reporter_id: string | null
  target_type: ReportTargetType
  target_id: string
  target_owner_id: string | null
  reason: ReportReason
  details: string | null
  status: ReportStatus
  resolution: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

const REPORT_COLUMNS = `id::text, reporter_id::text, target_type, target_id, target_owner_id::text,
  reason, details, status, resolution, resolved_by, resolved_at, created_at`

function sqlText(value: string | null | undefined): string {
  return value == null ? 'NULL' : `'${escapeSqlLiteral(value)}'`
}

function mapReport(row: Record<string, unknown>): ContentReport {
  const str = (v: unknown) => (v == null ? null : String(v))
  return {
    id: String(row.id),
    reporter_id: str(row.reporter_id),
    target_type: row.target_type as ReportTargetType,
    target_id: String(row.target_id),
    target_owner_id: str(row.target_owner_id),
    reason: row.reason as ReportReason,
    details: str(row.details),
    status: row.status as ReportStatus,
    resolution: str(row.resolution),
    resolved_by: str(row.resolved_by),
    resolved_at: str(row.resolved_at),
    created_at: String(row.created_at),
  }
}

/** Owner of the reported content, so moderators can act on the author as well. */
export async function resolveTargetOwner(
  targetType: ReportTargetType,
  targetId: string,
): Promise<string | null> {
  if (targetType === 'user') return assertUuid(targetId, 'target_id')
  const id = assertUuid(targetId, 'target_id')
  const sql =
    targetType === 'list'
      ? `SELECT owner_id::text AS owner FROM public.recommended_restaurant_lists WHERE uuid::text = '${id}' LIMIT 1`
      : `SELECT author_id::text AS owner FROM public.restaurant_reviews WHERE id::text = '${id}' LIMIT 1`
  const rows = await hasuraRunSql<{ owner: string | null }>(sql, { readOnly: true })
  return rows[0]?.owner ? String(rows[0].owner) : null
}

/** Idempotent per reporter + target while the report is open. */
export async function createReport(input: {
  reporterId: string
  targetType: ReportTargetType
  targetId: string
  targetOwnerId: string | null
  reason: ReportReason
  details?: string | null
}): Promise<ContentReport> {
  const reporter = assertUuid(input.reporterId, 'reporterId')
  const owner = input.targetOwnerId ? assertUuid(input.targetOwnerId, 'targetOwnerId') : null
  const targetId = escapeSqlLiteral(input.targetId)
  const rows = await hasuraRunSql<Record<string, unknown>>(
    `WITH inserted AS (
       INSERT INTO public.content_reports
         (reporter_id, target_type, target_id, target_owner_id, reason, details)
       VALUES ('${reporter}', '${input.targetType}', '${targetId}', ${owner ? `'${owner}'` : 'NULL'},
               '${input.reason}', ${sqlText(input.details?.trim() || null)})
       ON CONFLICT DO NOTHING
       RETURNING ${REPORT_COLUMNS}
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT ${REPORT_COLUMNS} FROM public.content_reports
      WHERE reporter_id = '${reporter}' AND target_type = '${input.targetType}'
        AND target_id = '${targetId}' AND status = 'open'
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
  )
  if (!rows[0]) throw new Error('createReport: insert returned no row')
  return mapReport(rows[0])
}

export async function listReports(opts: {
  status?: ReportStatus
  targetType?: ReportTargetType
  limit: number
  offset: number
}): Promise<{ reports: ContentReport[]; total: number }> {
  const where: string[] = []
  if (opts.status) where.push(`status = '${opts.status}'`)
  if (opts.targetType) where.push(`target_type = '${opts.targetType}'`)
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(opts.limit, 200))
  const offset = Math.max(0, opts.offset)

  const [rows, countRows] = await Promise.all([
    hasuraRunSql<Record<string, unknown>>(
      `SELECT ${REPORT_COLUMNS} FROM public.content_reports ${clause}
        ORDER BY created_at ASC LIMIT ${limit} OFFSET ${offset}`,
      { readOnly: true },
    ),
    hasuraRunSql<{ total: string }>(
      `SELECT count(*)::text AS total FROM public.content_reports ${clause}`,
      { readOnly: true },
    ),
  ])
  return { reports: rows.map(mapReport), total: Number(countRows[0]?.total ?? 0) }
}

export async function getReport(reportId: string): Promise<ContentReport | null> {
  const id = assertUuid(reportId, 'reportId')
  const rows = await hasuraRunSql<Record<string, unknown>>(
    `SELECT ${REPORT_COLUMNS} FROM public.content_reports WHERE id = '${id}' LIMIT 1`,
    { readOnly: true },
  )
  return rows[0] ? mapReport(rows[0]) : null
}

/** Resolves the report and every other open report on the same target. */
export async function resolveReports(input: {
  reportId: string
  status: Exclude<ReportStatus, 'open'>
  resolution: string
  resolvedBy: string
}): Promise<number> {
  const report = await getReport(input.reportId)
  if (!report) throw new Error('Report not found')
  const rows = await hasuraRunSql<{ id: string }>(
    `UPDATE public.content_reports
        SET status = '${input.status}', resolution = ${sqlText(input.resolution)},
            resolved_by = ${sqlText(input.resolvedBy)}, resolved_at = now()
      WHERE target_type = '${report.target_type}'
        AND target_id = '${escapeSqlLiteral(report.target_id)}'
        AND (status = 'open' OR id = '${report.id}')
      RETURNING id::text`,
  )
  return rows.length
}

export interface ReportTargetPreview {
  exists: boolean
  hidden: boolean
  title: string | null
  excerpt: string | null
  owner_username: string | null
}

/** Enough context for a moderator to judge the report without opening the app. */
export async function getReportTargetPreview(
  report: Pick<ContentReport, 'target_type' | 'target_id' | 'target_owner_id'>,
): Promise<ReportTargetPreview> {
  const id = escapeSqlLiteral(report.target_id)
  const owner = report.target_owner_id ? escapeSqlLiteral(report.target_owner_id) : null
  const ownerSql = owner
    ? `(SELECT username FROM public.user_profiles WHERE user_id::text = '${owner}' LIMIT 1)`
    : 'NULL'

  const sql =
    report.target_type === 'user'
      ? `SELECT true AS exists, (p.deleted_at IS NOT NULL OR u.disabled) AS hidden,
                p.username AS title, left(p.about_me, 500) AS excerpt, p.username AS owner_username
           FROM public.user_profiles p LEFT JOIN auth.users u ON u.id::text = p.user_id::text
          WHERE p.user_id::text = '${id}' LIMIT 1`
      : report.target_type === 'list'
        ? `SELECT true AS exists, (NOT coalesce(is_public, false)) AS hidden, title,
                  NULL AS excerpt, ${ownerSql} AS owner_username
             FROM public.recommended_restaurant_lists WHERE uuid::text = '${id}' LIMIT 1`
        : `SELECT true AS exists, (deleted_at IS NOT NULL) AS hidden, title,
                  left(content, 500) AS excerpt, ${ownerSql} AS owner_username
             FROM public.restaurant_reviews WHERE id::text = '${id}' LIMIT 1`

  const rows = await hasuraRunSql<Record<string, unknown>>(sql, { readOnly: true })
  const row = rows[0]
  if (!row) return { exists: false, hidden: true, title: null, excerpt: null, owner_username: null }
  const str = (v: unknown) => (v == null ? null : String(v))
  return {
    exists: true,
    hidden: row.hidden === true || row.hidden === 't' || row.hidden === 'true',
    title: str(row.title),
    excerpt: str(row.excerpt),
    owner_username: str(row.owner_username),
  }
}

/** Lists have no soft-delete column; unpublishing removes them from every public surface. */
export async function hideList(listUuid: string): Promise<boolean> {
  const id = assertUuid(listUuid, 'listUuid')
  const rows = await hasuraRunSql<{ uuid: string }>(
    `UPDATE public.recommended_restaurant_lists SET is_public = false
      WHERE uuid::text = '${id}' AND coalesce(is_public, false) = true
      RETURNING uuid::text`,
  )
  return rows.length > 0
}

/** Disables sign-in and ends every session; content stays until removed separately. */
export async function banUser(userId: string): Promise<boolean> {
  const id = assertUuid(userId, 'userId')
  const rows = await hasuraRunSql<{ id: string }>(
    `UPDATE auth.users SET disabled = true WHERE id::text = '${id}' RETURNING id::text`,
  )
  await hasuraRunSql(`DELETE FROM auth.refresh_tokens WHERE user_id::text = '${id}'`)
  return rows.length > 0
}

/** Soft-deletes every review and comment by the user (used with a ban). */
export async function hideAllContentByUser(userId: string): Promise<number> {
  const id = assertUuid(userId, 'userId')
  const rows = await hasuraRunSql<{ restaurant_uuid: string | null }>(
    `UPDATE public.restaurant_reviews SET deleted_at = now()
      WHERE author_id::text = '${id}' AND deleted_at IS NULL
      RETURNING restaurant_uuid::text`,
  )
  const restaurants = new Set(rows.map((r) => r.restaurant_uuid).filter(Boolean) as string[])
  for (const uuid of restaurants) {
    await rebuildRatingSummary(uuid).catch((error) => {
      console.error('[contentReports] rating rebuild failed', uuid, error)
    })
  }
  return rows.length
}

/** Soft-deletes a review or comment so every read path stops returning it. */
export async function hideReviewContent(reviewId: string): Promise<boolean> {
  const id = assertUuid(reviewId, 'reviewId')
  const rows = await hasuraRunSql<{ id: string; restaurant_uuid: string | null }>(
    `UPDATE public.restaurant_reviews SET deleted_at = now()
      WHERE id::text = '${id}' AND deleted_at IS NULL
      RETURNING id::text, restaurant_uuid::text`,
  )
  const restaurantUuid = rows[0]?.restaurant_uuid
  if (restaurantUuid) {
    await rebuildRatingSummary(String(restaurantUuid)).catch((error) => {
      console.error('[contentReports] rating rebuild failed', restaurantUuid, error)
    })
  }
  return rows.length > 0
}

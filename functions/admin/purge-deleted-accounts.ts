import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import { anonymiseAccount, listAccountsDueForPurge, type AnonymiseResult } from '../_lib/accountDeletion'
import { ok, fail } from '../_lib/respond'

/**
 * POST `admin/purge-deleted-accounts`
 * Header `x-admin-secret` required. Called daily by a Hasura cron trigger; anonymises every
 * account whose grace period has ended. Query `?limit=` (default 50, max 200) per run.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const limit = Number(req.query.limit) || 50
    const due = await listAccountsDueForPurge(limit)

    const purged: AnonymiseResult[] = []
    const failed: Array<{ userId: string; error: string }> = []
    for (const userId of due) {
      try {
        purged.push(await anonymiseAccount(userId))
      } catch (error) {
        console.error('[admin/purge-deleted-accounts]', userId, error)
        failed.push({ userId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    ok(res, { due: due.length, purged: purged.length, failed, results: purged })
  } catch (error) {
    console.error('[admin/purge-deleted-accounts]', error)
    fail(res, 'Internal server error', 500)
  }
}

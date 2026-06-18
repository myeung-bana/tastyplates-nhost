import type { Request, Response } from 'express'
import { ADMIN_SECRET } from '../_lib/env'
import { hasuraQuery } from '../_lib/hasura'
import { ensureUserProfile, getProfileById } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

const LIST_AUTH_USERS = `
  query ListAuthUsersForProfileBackfill($limit: Int!, $offset: Int!) {
    users(limit: $limit, offset: $offset, order_by: { createdAt: asc }) {
      id
    }
  }
`

/**
 * POST `admin/backfill-user-profiles`
 * Header: `x-admin-secret`
 * Query: `limit` (default 50), `offset` (default 0), `dry_run` (`true`|`false`)
 *
 * Ensures `user_profiles` exists for auth users missing a row (placeholder `user_<random>`).
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    const url = new URL(req.url, 'http://localhost')
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200)
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)
    const dryRun = url.searchParams.get('dry_run') === 'true'

    type UsersResult = { users: Array<{ id: string }> }
    const usersResult = await hasuraQuery<UsersResult>(LIST_AUTH_USERS, { limit, offset })

    if (usersResult.errors?.length) {
      console.error('[admin/backfill-user-profiles]', usersResult.errors)
      return fail(res, 'Failed to list auth users', 500)
    }

    const users = usersResult.data?.users ?? []
    let created = 0
    let existing = 0
    let failed = 0
    const createdIds: string[] = []

    for (const row of users) {
      if (dryRun) {
        const profile = await getProfileById(row.id)
        if (profile) existing++
        else created++
        continue
      }

      try {
        const result = await ensureUserProfile(row.id)
        if (result.created) {
          created++
          createdIds.push(row.id)
        } else {
          existing++
        }
      } catch (err) {
        failed++
        console.error('[admin/backfill-user-profiles] failed for', row.id, err)
      }
    }

    ok(res, {
      dryRun,
      limit,
      offset,
      scanned: users.length,
      created,
      existing,
      failed,
      createdIds: dryRun ? undefined : createdIds,
      hasMore: users.length === limit,
      nextOffset: users.length === limit ? offset + limit : null,
    })
  } catch (error) {
    console.error('[admin/backfill-user-profiles]', error)
    fail(res, 'Internal server error', 500)
  }
}

import type { Request, Response } from 'express'
import { resolveAuth } from '../_lib/auth-guard'
import { listBlockedUsers } from '../_lib/userBlocks'
import { getProfilesByIds, toFollowListUser } from '../_lib/user-profile'
import { ok, fail } from '../_lib/respond'

/**
 * GET `blocks/list-blocks`
 * Bearer required. Users the caller has blocked, newest first.
 * Optional `?user_id=` returns `{ blocked: boolean }` for a single user instead.
 */
export default async (req: Request, res: Response): Promise<void> => {
  try {
    const auth = await resolveAuth(req, res)
    if (!auth) return

    const blocks = await listBlockedUsers(auth.userId)

    const single = typeof req.query.user_id === 'string' ? req.query.user_id.toLowerCase() : null
    if (single) {
      return ok(res, { blocked: blocks.some((b) => b.user_id.toLowerCase() === single) })
    }

    const profiles = await getProfilesByIds(blocks.map((b) => b.user_id))
    const byId = new Map(profiles.map((p) => [p.user.id.toLowerCase(), toFollowListUser(p)]))

    ok(res, {
      blocked: blocks
        .filter((b) => byId.has(b.user_id.toLowerCase()))
        .map((b) => ({ blocked_at: b.blocked_at, user: byId.get(b.user_id.toLowerCase()) })),
    })
  } catch (error) {
    console.error('[blocks/list-blocks]', error)
    fail(res, 'Failed to load blocked users', 500)
  }
}

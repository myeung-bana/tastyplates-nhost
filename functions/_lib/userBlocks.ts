import type { Request, Response } from 'express'

import { resolveOptionalAuth } from './auth-guard'
import { assertUuid, hasuraRunSql } from './hasura-run-sql'

function isMissingBlocksTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('user_blocks') && message.includes('does not exist')
}

/** Users hidden from the viewer: anyone they blocked and anyone who blocked them. */
export async function getHiddenUserIds(viewerId: string): Promise<Set<string>> {
  const id = assertUuid(viewerId, 'viewerId')
  try {
    const rows = await hasuraRunSql<{ other_id: string }>(
      `SELECT blocked_id::text AS other_id FROM public.user_blocks WHERE blocker_id = '${id}'
       UNION
       SELECT blocker_id::text FROM public.user_blocks WHERE blocked_id = '${id}'`,
      { readOnly: true },
    )
    return new Set(rows.map((r) => String(r.other_id).toLowerCase()))
  } catch (error) {
    if (isMissingBlocksTable(error)) return new Set()
    throw error
  }
}

/** Hidden set for the optional Bearer viewer; empty for guests. */
export async function getHiddenUserIdsForRequest(
  req: Request,
  res: Response,
): Promise<Set<string>> {
  const viewer = await resolveOptionalAuth(req, res)
  if (!viewer) return new Set()
  return getHiddenUserIds(viewer.userId)
}

export function isHidden(hidden: Set<string>, userId: unknown): boolean {
  if (hidden.size === 0 || userId == null) return false
  return hidden.has(String(userId).trim().toLowerCase())
}

export function withoutHiddenAuthors<T extends Record<string, unknown>>(
  rows: T[],
  hidden: Set<string>,
  key = 'author_id',
): T[] {
  if (hidden.size === 0) return rows
  return rows.filter((row) => !isHidden(hidden, row[key]))
}

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  const blocker = assertUuid(blockerId, 'blockerId')
  const blocked = assertUuid(blockedId, 'blockedId')
  await hasuraRunSql(
    `INSERT INTO public.user_blocks (blocker_id, blocked_id)
       VALUES ('${blocker}', '${blocked}')
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
     DELETE FROM public.restaurant_user_follows
      WHERE (follower_id::text = '${blocker}' AND user_id::text = '${blocked}')
         OR (follower_id::text = '${blocked}' AND user_id::text = '${blocker}');`,
  )
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<boolean> {
  const blocker = assertUuid(blockerId, 'blockerId')
  const blocked = assertUuid(blockedId, 'blockedId')
  const rows = await hasuraRunSql<{ id: string }>(
    `DELETE FROM public.user_blocks
      WHERE blocker_id = '${blocker}' AND blocked_id = '${blocked}'
      RETURNING id`,
  )
  return rows.length > 0
}

export async function listBlockedUsers(
  blockerId: string,
): Promise<Array<{ user_id: string; blocked_at: string }>> {
  const blocker = assertUuid(blockerId, 'blockerId')
  try {
    const rows = await hasuraRunSql<{ user_id: string; blocked_at: string }>(
      `SELECT blocked_id::text AS user_id, created_at AS blocked_at
         FROM public.user_blocks WHERE blocker_id = '${blocker}'
        ORDER BY created_at DESC`,
      { readOnly: true },
    )
    return rows.map((r) => ({ user_id: String(r.user_id), blocked_at: String(r.blocked_at) }))
  } catch (error) {
    if (isMissingBlocksTable(error)) return []
    throw error
  }
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  return (await getHiddenUserIds(a)).has(b.toLowerCase())
}

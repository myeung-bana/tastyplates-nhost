/**
 * POST /v1/restaurant-lists/claim-lists
 *
 * Assigns owner_id to user playlists that were created without an owner
 * (e.g. Hasura Console inserts). Only updates rows where owner_id IS NULL.
 * Editorial lists (owner_id NULL, no share_token) are left unchanged unless
 * their uuid is explicitly claimed.
 *
 * Body: { list_uuids: string[] }  (1–50 uuids)
 * Auth: Required — owner_id is set to JWT x-hasura-user-id (= auth.users.id).
 */
import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const ClaimListsSchema = z.object({
  list_uuids: z.array(z.string().uuid()).min(1).max(50),
})

const CLAIM_LISTS = `
  mutation ClaimLists($uuids: [uuid!]!, $ownerId: uuid!, $now: timestamptz!) {
    update_recommended_restaurant_lists(
      where: {
        uuid: { _in: $uuids }
        owner_id: { _is_null: true }
      }
      _set: { owner_id: $ownerId, updated_at: $now }
    ) {
      returning {
        id uuid slug title owner_id is_public share_token updated_at
      }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, ClaimListsSchema)
    if (!body) return

    type Result = {
      update_recommended_restaurant_lists: {
        returning: Array<{
          id: number
          uuid: string
          slug: string
          title: string
          owner_id: string
          is_public: boolean
          share_token: string | null
          updated_at: string
        }>
      }
    }

    const data = await hasuraAdmin<Result>(CLAIM_LISTS, {
      uuids: body.list_uuids,
      ownerId,
      now: new Date().toISOString(),
    })

    const claimed = data.update_recommended_restaurant_lists.returning ?? []
    const skipped = body.list_uuids.length - claimed.length

    ok(res, {
      owner_id: ownerId,
      claimed,
      claimed_count: claimed.length,
      skipped_count: skipped,
    })
  } catch (error) {
    console.error('[restaurant-lists/claim-lists]', error)
    fail(res, 'Failed to claim lists', 500)
  }
}

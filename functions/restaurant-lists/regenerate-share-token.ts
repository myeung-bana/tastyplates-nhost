/**
 * POST /v1/restaurant-lists/regenerate-share-token
 *
 * Generates a fresh share token for an owned list, immediately invalidating
 * any previously shared links. Matches the Slack/Notion "reset invite link"
 * pattern for production hygiene.
 *
 * Body: { list_uuid: string }
 * Auth: Required.
 */
import type { Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const RegenerateTokenSchema = z.object({
  list_uuid: z.string().uuid(),
})

const VERIFY_OWNERSHIP = `
  query VerifyListOwnership($uuid: uuid!, $ownerId: uuid!) {
    recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid }, owner_id: { _eq: $ownerId } }
      limit: 1
    ) { id }
  }
`

const UPDATE_SHARE_TOKEN = `
  mutation UpdateShareToken($uuid: uuid!, $shareToken: String!) {
    update_recommended_restaurant_lists(
      where: { uuid: { _eq: $uuid } }
      _set: { share_token: $shareToken, updated_at: "now()" }
    ) {
      returning { uuid share_token updated_at }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, RegenerateTokenSchema)
    if (!body) return

    type OwnerCheck = { recommended_restaurant_lists: { id: number }[] }
    const check = await hasuraAdmin<OwnerCheck>(VERIFY_OWNERSHIP, {
      uuid: body.list_uuid,
      ownerId,
    })
    if ((check.recommended_restaurant_lists ?? []).length === 0) {
      fail(res, 'List not found', 404)
      return
    }

    const newToken = randomBytes(16).toString('base64url')

    type Result = { update_recommended_restaurant_lists: { returning: unknown[] } }
    const data = await hasuraAdmin<Result>(UPDATE_SHARE_TOKEN, {
      uuid: body.list_uuid,
      shareToken: newToken,
    })

    ok(res, { list: data.update_recommended_restaurant_lists.returning[0] })
  } catch (error) {
    console.error('[restaurant-lists/regenerate-share-token]', error)
    fail(res, 'Failed to regenerate share token', 500)
  }
}

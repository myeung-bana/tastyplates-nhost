import type { Request, Response } from 'express'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const SOFT_DELETE_USER = `
  mutation SoftDeleteUser($id: uuid!) {
    update_restaurant_users_by_pk(pk_columns: { id: $id } _set: { deleted_at: "now()" }) { id deleted_at }
  }
`

const HARD_DELETE_USER = `
  mutation HardDeleteUser($id: uuid!) {
    delete_restaurant_users_by_pk(id: $id) { id username }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    const url = new URL(req.url, 'http://localhost')
    const hard = url.searchParams.get('hard') === 'true'

    type Result = { update_restaurant_users_by_pk?: unknown; delete_restaurant_users_by_pk?: unknown }
    const result = await hasuraMutation<Result>(hard ? HARD_DELETE_USER : SOFT_DELETE_USER, { id: userId })

    if (result.errors?.length) {
      console.error('[restaurant-users/delete-restaurant-user]', result.errors)
      return fail(res, 'Failed to delete user', 500)
    }

    ok(res, { deleted: true, userId })
  } catch (error) {
    console.error('[restaurant-users/delete-restaurant-user]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

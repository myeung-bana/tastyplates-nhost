import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const UpdateUserSchema = z.object({
  username: z.string().optional(),
  display_name: z.string().optional(),
  about_me: z.string().optional(),
  profile_image: z.unknown().optional(),
  birthdate: z.string().optional(),
  gender: z.string().optional(),
  pronoun: z.string().optional(),
  address: z.unknown().optional(),
  palates: z.unknown().optional(),
  language_preference: z.string().optional(),
  onboarding_complete: z.boolean().optional(),
})

const UPDATE_RESTAURANT_USER = `
  mutation UpdateRestaurantUser($id: uuid!, $changes: restaurant_users_set_input!) {
    update_restaurant_users_by_pk(pk_columns: { id: $id } _set: $changes) {
      id username email display_name profile_image about_me palates language_preference onboarding_complete updated_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    const changes = validate(req, res, UpdateUserSchema)
    if (!changes) return

    type Result = { update_restaurant_users_by_pk: unknown }
    const result = await hasuraMutation<Result>(UPDATE_RESTAURANT_USER, { id: userId, changes })

    if (result.errors?.length) {
      console.error('[restaurant-users/update-restaurant-user]', result.errors)
      return fail(res, 'Failed to update user', 500)
    }

    ok(res, { user: result.data?.update_restaurant_users_by_pk })
  } catch (error) {
    console.error('[restaurant-users/update-restaurant-user]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

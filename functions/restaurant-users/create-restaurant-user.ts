import type { Request, Response } from 'express'
import { z } from 'zod'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string().optional(),
  email: z.string().email().optional(),
  display_name: z.string().optional(),
  auth_method: z.string().optional(),
  language_preference: z.string().optional(),
  palates: z.unknown().optional(),
  onboarding_complete: z.boolean().optional(),
})

const CREATE_RESTAURANT_USER = `
  mutation CreateRestaurantUser($object: restaurant_users_insert_input!) {
    insert_restaurant_users_one(object: $object) {
      id username email display_name profile_image auth_method palates onboarding_complete created_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const body = validate(req, res, CreateUserSchema)
    if (!body) return

    type Result = { insert_restaurant_users_one: unknown }
    const result = await hasuraMutation<Result>(CREATE_RESTAURANT_USER, { object: body })

    if (result.errors?.length) {
      console.error('[restaurant-users/create-restaurant-user]', result.errors)
      return fail(res, 'Failed to create user', 500)
    }

    ok(res, { user: result.data?.insert_restaurant_users_one }, 201)
  } catch (error) {
    console.error('[restaurant-users/create-restaurant-user]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_RESTAURANT_USER_BY_ID = `
  query GetRestaurantUserById($id: uuid!) {
    restaurant_users_by_pk(id: $id) {
      id username email display_name profile_image about_me birthdate gender pronoun address zip_code
      latitude longitude palates language_preference auth_method onboarding_complete created_at updated_at
    }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')

    if (!id) return fail(res, 'Missing required param: id', 400)
    if (!UUID_REGEX.test(id)) return fail(res, 'Invalid UUID format', 400)

    type Result = { restaurant_users_by_pk: unknown | null }
    const result = await hasuraQuery<Result>(GET_RESTAURANT_USER_BY_ID, { id })

    if (result.errors?.length) {
      console.error('[restaurant-users/get-restaurant-user-by-id]', result.errors)
      return fail(res, 'Failed to fetch user', 500)
    }

    const user = result.data?.restaurant_users_by_pk
    if (!user) return fail(res, 'User not found', 404)

    ok(res, { user })
  } catch (error) {
    console.error('[restaurant-users/get-restaurant-user-by-id]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

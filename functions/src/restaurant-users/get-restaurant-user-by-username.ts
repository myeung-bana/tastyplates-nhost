import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const GET_RESTAURANT_USER_BY_USERNAME = `
  query GetRestaurantUserByUsername($username: String!) {
    restaurant_users(where: { username: { _eq: $username } deleted_at: { _is_null: true } } limit: 1) {
      id username email display_name profile_image about_me birthdate gender pronoun address zip_code
      latitude longitude palates language_preference auth_method onboarding_complete created_at updated_at
      avatarUrl
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const username = url.searchParams.get('username')

    if (!username) return fail(res, 'Missing required param: username', 400)

    type Result = { restaurant_users: unknown[] }
    const result = await hasuraQuery<Result>(GET_RESTAURANT_USER_BY_USERNAME, { username })

    if (result.errors?.length) {
      console.error('[restaurant-users/get-restaurant-user-by-username]', result.errors)
      return fail(res, 'Failed to fetch user', 500)
    }

    const user = result.data?.restaurant_users?.[0]
    if (!user) return fail(res, 'User not found', 404)

    ok(res, { user })
  } catch (error) {
    console.error('[restaurant-users/get-restaurant-user-by-username]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

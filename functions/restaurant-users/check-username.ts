import type { Request, Response } from 'express'
import { hasuraQuery } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const CHECK_USERNAME = `
  query CheckUsername($username: String!) {
    restaurant_users(where: { username: { _eq: $username } } limit: 1) { id }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const username = url.searchParams.get('username')

    if (!username) return fail(res, 'Missing required param: username', 400)

    type Result = { restaurant_users: unknown[] }
    const result = await hasuraQuery<Result>(CHECK_USERNAME, { username })

    if (result.errors?.length) {
      console.error('[restaurant-users/check-username]', result.errors)
      return fail(res, 'Failed to check username', 500)
    }

    const count = result.data?.restaurant_users?.length ?? 0
    ok(res, { available: count === 0 })
  } catch (error) {
    console.error('[restaurant-users/check-username]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

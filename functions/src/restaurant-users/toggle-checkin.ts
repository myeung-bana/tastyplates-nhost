import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraQuery, hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'

const ToggleCheckinSchema = z.object({
  restaurant_uuid: z.string().uuid().optional(),
  restaurant_slug: z.string().optional(),
}).refine(data => data.restaurant_uuid || data.restaurant_slug, {
  message: 'Either restaurant_uuid or restaurant_slug is required',
})

const GET_RESTAURANT_UUID_BY_SLUG = `
  query GetRestaurantUuidBySlug($slug: String!) {
    restaurants(where: { slug: { _eq: $slug } status: { _eq: "publish" } } limit: 1) { uuid }
  }
`

const CHECK_USER_CHECKIN = `
  query CheckUserCheckin($user_id: uuid!, $restaurant_uuid: uuid!) {
    user_checkins(where: { user_id: { _eq: $user_id } restaurant_uuid: { _eq: $restaurant_uuid } } limit: 1) { id }
  }
`

const ADD_CHECKIN = `
  mutation AddCheckin($user_id: uuid!, $restaurant_uuid: uuid!) {
    insert_user_checkins_one(object: { user_id: $user_id restaurant_uuid: $restaurant_uuid }) { id checked_in_at }
  }
`

const REMOVE_CHECKIN = `
  mutation RemoveCheckin($user_id: uuid!, $restaurant_uuid: uuid!) {
    delete_user_checkins(where: { user_id: { _eq: $user_id } restaurant_uuid: { _eq: $restaurant_uuid } }) { affected_rows }
  }
`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveRestaurantUuid(uuidParam: string | undefined, slugParam: string | undefined): Promise<string | null> {
  if (uuidParam) return uuidParam

  if (!slugParam) return null

  type Result = { restaurants: Array<{ uuid: string }> }
  const result = await hasuraQuery<Result>(GET_RESTAURANT_UUID_BY_SLUG, { slug: slugParam })
  return result.data?.restaurants?.[0]?.uuid ?? null
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const userId = getUserId(payload)

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost')
      const restaurantUuid = url.searchParams.get('restaurant_uuid') ?? undefined
      const restaurantSlug = url.searchParams.get('restaurant_slug') ?? undefined

      if (!restaurantUuid && !restaurantSlug) {
        return fail(res, 'Missing required param: restaurant_uuid or restaurant_slug', 400)
      }

      const resolvedUuid = await resolveRestaurantUuid(restaurantUuid, restaurantSlug)
      if (!resolvedUuid) return fail(res, 'Restaurant not found', 404)
      if (!UUID_REGEX.test(resolvedUuid)) return fail(res, 'Invalid restaurant UUID', 400)

      type CheckResult = { user_checkins: Array<{ id: string }> }
      const checkResult = await hasuraQuery<CheckResult>(CHECK_USER_CHECKIN, { user_id: userId, restaurant_uuid: resolvedUuid })
      const isCheckedIn = (checkResult.data?.user_checkins ?? []).length > 0

      return ok(res, { status: isCheckedIn ? 'checkedin' : 'uncheckedin' })
    }

    const bodyParsed = ToggleCheckinSchema.safeParse(req.body)
    if (!bodyParsed.success) {
      return fail(res, 'Validation failed', 422, bodyParsed.error.issues)
    }

    const { restaurant_uuid, restaurant_slug } = bodyParsed.data

    const resolvedUuid = await resolveRestaurantUuid(restaurant_uuid, restaurant_slug)
    if (!resolvedUuid) return fail(res, 'Restaurant not found', 404)
    if (!UUID_REGEX.test(resolvedUuid)) return fail(res, 'Invalid restaurant UUID', 400)

    type CheckResult = { user_checkins: Array<{ id: string }> }
    const checkResult = await hasuraQuery<CheckResult>(CHECK_USER_CHECKIN, { user_id: userId, restaurant_uuid: resolvedUuid })
    const isCheckedIn = (checkResult.data?.user_checkins ?? []).length > 0

    if (isCheckedIn) {
      await hasuraMutation(REMOVE_CHECKIN, { user_id: userId, restaurant_uuid: resolvedUuid })
      return ok(res, { status: 'uncheckedin', restaurant_uuid: resolvedUuid })
    } else {
      await hasuraMutation(ADD_CHECKIN, { user_id: userId, restaurant_uuid: resolvedUuid })
      return ok(res, { status: 'checkedin', restaurant_uuid: resolvedUuid })
    }
  } catch (error) {
    console.error('[restaurant-users/toggle-checkin]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

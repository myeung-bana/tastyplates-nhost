/**
 * POST `admin/update-restaurant`
 * Header: `x-admin-secret`
 * Body: `{ uuid, status?, title?, featured_image_url?, listing_street?, phone?, palates?, cuisines? }`
 */
import type { Request, Response } from 'express'
import { z } from 'zod'

import { ADMIN_SECRET } from '../_lib/env'
import { hasuraAdmin, hasuraQuery } from '../_lib/hasura'
import { fail, ok } from '../_lib/respond'
import { validate } from '../_lib/validate'

const BodySchema = z.object({
  uuid: z.string().uuid(),
  status: z.enum(['publish', 'draft']).optional(),
  title: z.string().min(1).optional(),
  featured_image_url: z.string().url().nullable().optional(),
  listing_street: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  palates: z.unknown().optional(),
  cuisines: z.unknown().optional(),
  categories: z.unknown().optional(),
})

const UPDATE_RESTAURANT = `
  mutation AdminUpdateRestaurant($uuid: uuid!, $changes: restaurants_set_input!) {
    update_restaurants(where: { uuid: { _eq: $uuid } }, _set: $changes) {
      affected_rows
      returning {
        id uuid title slug status listing_street phone featured_image_url palates cuisines categories
      }
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const adminSecret = req.headers['x-admin-secret']
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
      return fail(res, 'Unauthorized', 401)
    }

    if (req.method !== 'POST') {
      return fail(res, 'Method not allowed', 405)
    }

    const body = validate(req, res, BodySchema)
    if (!body) return

    const changes: Record<string, unknown> = {}
    if (body.status !== undefined) changes.status = body.status
    if (body.title !== undefined) changes.title = body.title
    if (body.featured_image_url !== undefined) changes.featured_image_url = body.featured_image_url
    if (body.listing_street !== undefined) changes.listing_street = body.listing_street
    if (body.phone !== undefined) changes.phone = body.phone
    if (body.palates !== undefined) changes.palates = body.palates
    if (body.cuisines !== undefined) changes.cuisines = body.cuisines
    if (body.categories !== undefined) changes.categories = body.categories

    if (Object.keys(changes).length === 0) {
      return fail(res, 'No fields to update', 400)
    }

    type UpdateResult = {
      update_restaurants: {
        affected_rows: number
        returning: Array<Record<string, unknown>>
      }
    }

    const result = await hasuraAdmin<UpdateResult>(UPDATE_RESTAURANT, {
      uuid: body.uuid,
      changes,
    })

    if (!result.update_restaurants.affected_rows) {
      // Confirm missing vs no-op
      const check = await hasuraQuery<{ restaurants: Array<{ uuid: string }> }>(
        `query ($uuid: uuid!) { restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) { uuid } }`,
        { uuid: body.uuid },
      )
      if (!check.data?.restaurants?.length) {
        return fail(res, 'Restaurant not found', 404)
      }
    }

    ok(res, {
      restaurant: result.update_restaurants.returning[0] ?? null,
      affected_rows: result.update_restaurants.affected_rows,
    })
  } catch (error) {
    console.error('[admin/update-restaurant]', error)
    fail(res, 'Internal server error', 500)
  }
}

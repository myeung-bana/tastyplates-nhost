import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateRestaurantSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  address: z.unknown().optional(),
  listing_street: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  phone: z.string().optional(),
  menu_url: z.string().optional(),
  featured_image_url: z.string().optional(),
  cuisines: z.unknown().optional(),
  palates: z.unknown().optional(),
  categories: z.unknown().optional(),
  price_range_id: z.number().optional(),
  status: z.enum(['publish', 'draft']).default('publish'),
})

const CREATE_RESTAURANT = `
  mutation CreateRestaurant($object: restaurants_insert_input!) {
    insert_restaurants_one(object: $object) {
      id uuid title slug status listing_street phone longitude latitude featured_image_url address created_at
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const body = validate(req, res, CreateRestaurantSchema)
    if (!body) return

    type Result = { insert_restaurants_one: unknown }
    const result = await hasuraMutation<Result>(CREATE_RESTAURANT, { object: body })

    if (result.errors?.length) {
      console.error('[restaurants-v2/create-restaurant]', result.errors)
      return fail(res, 'Failed to create restaurant', 500)
    }

    ok(res, { restaurant: result.data?.insert_restaurants_one }, 201)
  } catch (error) {
    console.error('[restaurants-v2/create-restaurant]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { upsertGooglePlaceCacheSafe } from '../_lib/googlePlaceCache'
import { normalizeGoogleRatingPrior } from '../_lib/googleRatingPrior'
import { resolveGoogleFeaturedImageUrl } from '../_lib/ingestGooglePlacePhoto'
import { scheduleRatingSummaryRebuild } from '../_lib/rebuildRatingSummary'
import { hasuraMutation } from '../_lib/hasura'
import { ok } from '../_lib/respond'
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
  google_place_id: z.string().min(1).max(500).optional(),
  google_photo_reference: z.string().min(1).max(500).optional(),
  google_rating: z.number().min(0).max(5).optional(),
  user_ratings_total: z.number().int().min(0).optional(),
  cuisines: z.unknown().optional(),
  palates: z.unknown().optional(),
  categories: z.unknown().optional(),
  price_range_id: z.number().optional(),
  status: z.enum(['publish', 'draft']).default('publish'),
})

const CREATE_RESTAURANT = `
  mutation CreateRestaurant($object: restaurants_insert_input!) {
    insert_restaurants_one(object: $object) {
      id uuid title slug status listing_street phone longitude latitude featured_image_url google_place_id address created_at
    }
  }
`

function resolveGooglePlaceId(
  explicit: string | undefined,
  address: unknown,
): string | null {
  const fromBody = explicit?.trim()
  if (fromBody) return fromBody
  if (address && typeof address === 'object' && address !== null) {
    const placeId = (address as { place_id?: string }).place_id?.trim()
    if (placeId) return placeId
  }
  return null
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const body = validate(req, res, CreateRestaurantSchema)
    if (!body) return

    const userId = getUserId(payload)
    const {
      google_place_id: googlePlaceIdInput,
      google_photo_reference: googlePhotoReference,
      google_rating: googleRatingInput,
      user_ratings_total: userRatingsTotalInput,
      featured_image_url: featuredImageInput,
      ...restaurantFields
    } = body

    const googlePlaceId = resolveGooglePlaceId(googlePlaceIdInput, body.address)
    const googleRating = normalizeGoogleRatingPrior(googleRatingInput)
    const userRatingsTotal =
      userRatingsTotalInput != null && Number.isFinite(userRatingsTotalInput)
        ? Math.max(0, Math.floor(userRatingsTotalInput))
        : null

    let featuredImageUrl = featuredImageInput?.trim() || null
    if (!featuredImageUrl && googlePhotoReference?.trim()) {
      featuredImageUrl = await resolveGoogleFeaturedImageUrl(googlePhotoReference.trim(), userId, {
        filenameHint: `restaurant-${body.slug}`,
      })
    }

    const object: Record<string, unknown> = { ...restaurantFields }
    if (googlePlaceId) object.google_place_id = googlePlaceId
    if (featuredImageUrl) object.featured_image_url = featuredImageUrl

    type Result = { insert_restaurants_one: Record<string, unknown> | null }
    const data = await hasuraMutation<Result>(CREATE_RESTAURANT, { object })

    const restaurant = data.insert_restaurants_one
    const restaurantUuid = typeof restaurant?.uuid === 'string' ? restaurant.uuid : null

    if (googlePlaceId && restaurant) {
      await upsertGooglePlaceCacheSafe({
        google_place_id: googlePlaceId,
        name: body.title,
        formatted_address: body.listing_street ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        primary_photo_url: featuredImageUrl,
        google_rating: googleRating,
        user_ratings_total: userRatingsTotal,
        tastyplates_restaurant_uuid: restaurantUuid,
        tastyplates_restaurant_slug: typeof restaurant.slug === 'string' ? restaurant.slug : null,
      })
    }

    if (restaurantUuid) {
      scheduleRatingSummaryRebuild(restaurantUuid)
    }

    ok(res, { restaurant }, 201)
  } catch (error) {
    console.error('[restaurants-v2/create-restaurant]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

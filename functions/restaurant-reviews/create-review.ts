import type { Request, Response } from 'express'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraMutation } from '../_lib/hasura'
import {
  normalizeReviewRating,
  ReviewImageSchema,
  ReviewRatingSchema,
} from '../_lib/reviewSchemas'
import { backfillRestaurantFeaturedFromReview } from '../_lib/restaurantFeaturedImage'
import { scheduleRatingSummaryRebuild } from '../_lib/rebuildRatingSummary'
import { ok } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateReviewSchema = z.object({
  restaurant_uuid: z.string().uuid(),
  title: z.string().max(500).optional().nullable(),
  content: z.string().min(1),
  rating: ReviewRatingSchema,
  status: z.enum(['approved', 'draft']).default('approved'),
  images: z.array(ReviewImageSchema).optional().nullable(),
  palates: z.unknown().optional().nullable(),
  hashtags: z.array(z.string()).optional().nullable(),
  recognitions: z.array(z.string()).optional().nullable(),
})

const CREATE_REVIEW = `
  mutation CreateReview($object: restaurant_reviews_insert_input!) {
    insert_restaurant_reviews_one(object: $object) {
      id title content rating status created_at restaurant_uuid author_id images
    }
  }
`

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return

    const authorId = getUserId(payload)

    const body = validate(req, res, CreateReviewSchema)
    if (!body) return

    const normalizedHashtags = (body.hashtags ?? [])
      .map((tag) => tag.replace(/^#/, '').toLowerCase().trim())
      .filter(Boolean)

    // Rating aggregates rebuilt asynchronously after insert.
    type Result = { insert_restaurant_reviews_one: unknown }
    const reviewImages = body.images?.length ? body.images : null

    const data = await hasuraMutation<Result>(CREATE_REVIEW, {
      object: {
        restaurant_uuid: body.restaurant_uuid,
        author_id: authorId,
        title: body.title?.trim() || null,
        content: body.content,
        rating: normalizeReviewRating(body.rating),
        images: reviewImages,
        palates: body.palates ?? null,
        hashtags: normalizedHashtags.length > 0 ? normalizedHashtags : null,
        recognitions: body.recognitions?.length ? body.recognitions : null,
        status: body.status,
      },
    })

    await backfillRestaurantFeaturedFromReview(body.restaurant_uuid, reviewImages)

    scheduleRatingSummaryRebuild(body.restaurant_uuid)

    ok(res, { review: data.insert_restaurant_reviews_one }, 201)
  } catch (error) {
    console.error('[restaurant-reviews/create-review]', error)
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}

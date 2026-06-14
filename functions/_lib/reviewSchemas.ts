import { z } from 'zod'

export const ReviewImageSchema = z.object({
  id: z.string(),
  url: z.string().min(1),
  thumbnail_url: z.string().min(1).optional(),
  alt_text: z.string().optional(),
  display_order: z.number().int().optional(),
})

/** Half-star ratings from mobile/web (0.5 … 5.0). */
export const ReviewRatingSchema = z
  .number()
  .min(0.5)
  .max(5)
  .refine((value) => Number.isInteger(Math.round(value * 2)), {
    message: 'Rating must be in 0.5 increments',
  })

export function normalizeReviewRating(rating: number): number {
  return parseFloat(rating.toFixed(1))
}

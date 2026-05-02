import type { Request, Response } from 'express';
import { hasuraMutation } from '../_lib/hasura-client';
import { rateLimitOrThrow, createRateLimit } from '../_lib/rate-limit';
import { bumpVersion } from '../_lib/versioning';
import { rebuildRatingSummary } from '../_lib/rebuild-rating-summary';
import { CREATE_REVIEW } from '../_lib/graphql/review-queries';
import { reviewCreateSchema } from '../_lib/validate';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const parsed = reviewCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Invalid request body' });
      return;
    }

    const {
      restaurant_uuid,
      author_id,
      title,
      content,
      rating,
      images,
      palates,
      hashtags,
      mentions,
      recognitions,
      status,
      parent_review_id,
    } = parsed.data;

    const rl = await rateLimitOrThrow(author_id, createRateLimit);
    if (!rl.ok) {
      res.status(429).set('Retry-After', String(rl.retryAfter)).json({
        success: false,
        error: 'Rate limit exceeded. Please wait before creating another review.',
        retryAfter: rl.retryAfter,
      });
      return;
    }

    const normalizedHashtags = hashtags
      .map((tag) => tag.replace(/^#/, '').toLowerCase().trim())
      .filter(Boolean);

    const result = await hasuraMutation(CREATE_REVIEW, {
      object: {
        restaurant_uuid,
        author_id,
        title: title || null,
        content,
        rating: parseFloat(rating.toFixed(1)),
        images: images.length > 0 ? images : null,
        palates: palates.length > 0 ? palates : null,
        hashtags: normalizedHashtags.length > 0 ? normalizedHashtags : null,
        mentions: mentions.length > 0 ? mentions : null,
        recognitions: recognitions.length > 0 ? recognitions : null,
        status,
        parent_review_id: parent_review_id || null,
      },
    });

    if (result.errors) {
      console.error('[reviews/create] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to create review' });
      return;
    }

    const createdReview = result.data?.insert_restaurant_reviews_one;
    if (!createdReview) {
      res.status(500).json({ success: false, error: 'Failed to create review' });
      return;
    }

    rebuildRatingSummary(restaurant_uuid).catch((e) =>
      console.error('[reviews/create] rebuildRatingSummary failed:', e)
    );

    await Promise.all([
      bumpVersion(`v:restaurant:${restaurant_uuid}:reviews`),
      bumpVersion('v:reviews:all'),
      bumpVersion(`v:user:${author_id}:reviews`),
      bumpVersion('v:restaurants:all'),
    ]);

    res.json({ success: true, data: createdReview });
  } catch (error: any) {
    console.error('[reviews/create] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

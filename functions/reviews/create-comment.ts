import type { Request, Response } from 'express';
import { hasuraMutation, hasuraQuery } from '../_lib/hasura-client';
import { rateLimitOrThrow, createRateLimit } from '../_lib/rate-limit';
import { bumpVersion } from '../_lib/versioning';
import { CREATE_REVIEW, GET_REVIEW_BY_ID, INCREMENT_REPLIES_COUNT } from '../_lib/graphql/review-queries';
import { commentCreateSchema } from '../_lib/validate';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const parsed = commentCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Invalid request body' });
      return;
    }

    const { parent_review_id, author_id, content, restaurant_uuid } = parsed.data;

    const rl = await rateLimitOrThrow(author_id, createRateLimit);
    if (!rl.ok) {
      res.status(429).set('Retry-After', String(rl.retryAfter)).json({
        success: false,
        error: 'Rate limit exceeded. Please wait before posting another comment.',
        retryAfter: rl.retryAfter,
      });
      return;
    }

    let finalRestaurantUuid = restaurant_uuid;
    if (!finalRestaurantUuid) {
      const parentResult = await hasuraQuery(GET_REVIEW_BY_ID, { id: parent_review_id });
      if (parentResult.errors || !parentResult.data?.restaurant_reviews_by_pk) {
        res.status(404).json({ success: false, error: 'Parent review not found' });
        return;
      }
      finalRestaurantUuid = parentResult.data.restaurant_reviews_by_pk.restaurant_uuid;
    }

    const result = await hasuraMutation(CREATE_REVIEW, {
      object: {
        restaurant_uuid: finalRestaurantUuid,
        author_id,
        content,
        status: 'approved',
        parent_review_id,
      },
    });

    if (result.errors) {
      console.error('[reviews/create-comment] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to create comment' });
      return;
    }

    const createdComment = result.data?.insert_restaurant_reviews_one;
    if (!createdComment) {
      res.status(500).json({ success: false, error: 'Failed to create comment' });
      return;
    }

    hasuraMutation(INCREMENT_REPLIES_COUNT, { id: parent_review_id }).catch((err) =>
      console.error('[reviews/create-comment] Failed to increment replies_count:', err)
    );

    await bumpVersion(`v:review:${parent_review_id}:replies`);

    res.json({ success: true, data: createdComment });
  } catch (error: any) {
    console.error('[reviews/create-comment] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

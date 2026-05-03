import type { Request, Response } from 'express';
import { hasuraMutation } from '../_lib/hasura-client';
import { bumpVersion } from '../_lib/versioning';
import { rebuildRatingSummary } from '../_lib/rebuild-rating-summary';
import { UPDATE_REVIEW } from '../_lib/graphql/review-queries';
import { reviewUpdateSchema } from '../_lib/validate';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'PUT') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const parsed = reviewUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Invalid request body' });
      return;
    }

    const { id, title, content, rating, images, palates, hashtags, mentions, recognitions, status } = parsed.data;

    const changes: Record<string, any> = {};

    if (title !== undefined) changes.title = title ?? null;
    if (content !== undefined) changes.content = content;
    if (rating !== undefined) changes.rating = parseFloat(rating.toFixed(1));
    if (images !== undefined) changes.images = images ?? null;
    if (palates !== undefined) changes.palates = palates ?? null;
    if (hashtags !== undefined) {
      changes.hashtags = hashtags
        ? hashtags.map((t) => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean)
        : null;
    }
    if (mentions !== undefined) changes.mentions = mentions ?? null;
    if (recognitions !== undefined) changes.recognitions = recognitions ?? null;
    if (status !== undefined) changes.status = status;

    if (Object.keys(changes).length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    const result = await hasuraMutation(UPDATE_REVIEW, { id, changes });

    if (result.errors) {
      console.error('[reviews/update] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to update review' });
      return;
    }

    const updatedReview = result.data?.update_restaurant_reviews_by_pk;
    if (!updatedReview) {
      res.status(404).json({ success: false, error: 'Review not found or update failed' });
      return;
    }

    if (updatedReview.restaurant_uuid) {
      rebuildRatingSummary(updatedReview.restaurant_uuid).catch((e) =>
        console.error('[reviews/update] rebuildRatingSummary failed:', e)
      );
      await Promise.all([
        bumpVersion(`v:restaurant:${updatedReview.restaurant_uuid}:reviews`),
        bumpVersion('v:reviews:all'),
        bumpVersion('v:restaurants:all'),
      ]);
    }

    res.json({ success: true, data: updatedReview });
  } catch (error: any) {
    console.error('[reviews/update] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

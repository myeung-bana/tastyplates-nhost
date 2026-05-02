import type { Request, Response } from 'express';
import { hasuraMutation } from '../_lib/hasura-client';
import { bumpVersion } from '../_lib/versioning';
import { rebuildRatingSummary } from '../_lib/rebuild-rating-summary';
import { DELETE_REVIEW, DECREMENT_REPLIES_COUNT } from '../_lib/graphql/review-queries';
import { isValidUUID } from '../_lib/validate';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'DELETE') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const id = req.query.id as string;

  if (!id) {
    res.status(400).json({ success: false, error: 'Review ID is required' });
    return;
  }

  if (!isValidUUID(id)) {
    res.status(400).json({ success: false, error: 'Invalid review ID format. Expected UUID.' });
    return;
  }

  try {
    const result = await hasuraMutation(DELETE_REVIEW, { id });

    if (result.errors) {
      console.error('[reviews/delete] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to delete review' });
      return;
    }

    const deletedReview = result.data?.update_restaurant_reviews_by_pk;
    if (!deletedReview) {
      res.status(404).json({ success: false, error: 'Review not found' });
      return;
    }

    if (deletedReview.parent_review_id) {
      hasuraMutation(DECREMENT_REPLIES_COUNT, { id: deletedReview.parent_review_id }).catch((err) =>
        console.error('[reviews/delete] Failed to decrement replies_count:', err)
      );
    }

    if (deletedReview.restaurant_uuid) {
      rebuildRatingSummary(deletedReview.restaurant_uuid).catch((e) =>
        console.error('[reviews/delete] rebuildRatingSummary failed:', e)
      );
      await Promise.all([
        bumpVersion(`v:restaurant:${deletedReview.restaurant_uuid}:reviews`),
        bumpVersion('v:reviews:all'),
        bumpVersion('v:restaurants:all'),
      ]);
    }

    res.json({ success: true, data: deletedReview });
  } catch (error: any) {
    console.error('[reviews/delete] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

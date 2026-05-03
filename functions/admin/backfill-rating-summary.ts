import type { Request, Response } from 'express';
import { hasuraQuery } from '../_lib/hasura-client';
import { rebuildRatingSummary } from '../_lib/rebuild-rating-summary';
import { bumpVersion } from '../_lib/versioning';
import { requireAdminSecret } from '../_lib/auth';
import { GET_ALL_RESTAURANT_UUIDS_PAGINATED } from '../_lib/graphql/restaurant-queries';

const BATCH_SIZE = 20;

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const providedSecret = req.headers['x-admin-secret'] as string | undefined;
  if (!requireAdminSecret(providedSecret)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const countResult = await hasuraQuery<{
      restaurants: Array<{ uuid: string; title: string }>;
      restaurants_aggregate: { aggregate: { count: number } };
    }>(GET_ALL_RESTAURANT_UUIDS_PAGINATED, { limit: 1, offset: 0 });

    if (countResult.errors) {
      throw new Error(countResult.errors[0]?.message || 'Failed to count restaurants');
    }

    const total = countResult.data?.restaurants_aggregate?.aggregate?.count ?? 0;
    console.log(`[backfill] Starting for ${total} restaurants`);

    let rebuilt = 0;
    let failed = 0;
    const failures: string[] = [];

    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const batchResult = await hasuraQuery<{ restaurants: Array<{ uuid: string; title: string }> }>(
        GET_ALL_RESTAURANT_UUIDS_PAGINATED,
        { limit: BATCH_SIZE, offset }
      );

      if (batchResult.errors) {
        console.error(`[backfill] Batch error at offset ${offset}:`, batchResult.errors);
        failed += BATCH_SIZE;
        continue;
      }

      for (const restaurant of batchResult.data?.restaurants ?? []) {
        try {
          await rebuildRatingSummary(restaurant.uuid);
          rebuilt++;
          if (rebuilt % 10 === 0) console.log(`[backfill] Progress: ${rebuilt}/${total}`);
        } catch (err) {
          failed++;
          failures.push(`${restaurant.title} (${restaurant.uuid}): ${err}`);
          console.error(`[backfill] Failed for ${restaurant.uuid}:`, err);
        }
      }
    }

    await Promise.all([bumpVersion('v:restaurants:all'), bumpVersion('v:reviews:all')]);

    console.log(`[backfill] Complete. Rebuilt: ${rebuilt}, Failed: ${failed}`);

    res.json({
      success: true,
      total,
      rebuilt,
      failed,
      failures: failures.length > 0 ? failures : undefined,
    });
  } catch (error: any) {
    console.error('[backfill] Fatal error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

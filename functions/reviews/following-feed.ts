import type { Request, Response } from 'express';
import { hasuraQuery } from '../_lib/hasura-client';
import { cacheGetOrSetJSON } from '../_lib/cache';
import { getVersion } from '../_lib/versioning';
import { decodeReviewCursor, encodeReviewCursor } from '../_lib/cursor-pagination';
import { GET_FOLLOWING_LIST, GET_RESTAURANT_USERS_BY_IDS } from '../_lib/graphql/user-queries';
import {
  GET_REVIEWS_BY_AUTHORS,
  GET_REVIEWS_BY_AUTHORS_CURSOR,
} from '../_lib/graphql/review-queries';
import { GET_RESTAURANTS_BY_UUIDS } from '../_lib/graphql/restaurant-queries';
import { isValidUUID } from '../_lib/validate';

const BATCH_FOLLOWING_MAX = 100;
const BATCH_RESTAURANTS_MAX = 100;
const BATCH_USERS_MAX = 100;
const API_MAX = 50;

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const userId = req.query.user_id as string;
  const limitParam = parseInt((req.query.limit as string) || '10', 10);
  const limit = Math.min(isNaN(limitParam) ? 10 : limitParam, API_MAX);
  const cursorParam = req.query.cursor as string | undefined;
  const decodedCursor = cursorParam ? decodeReviewCursor(cursorParam) : null;
  const useCursorPagination = !!decodedCursor;
  const offset = useCursorPagination ? 0 : parseInt((req.query.offset as string) || '0', 10);

  if (!userId) {
    res.status(400).json({ success: false, error: 'user_id is required' });
    return;
  }

  if (!isValidUUID(userId)) {
    res.status(400).json({ success: false, error: 'Invalid user_id format. Expected UUID.' });
    return;
  }

  try {
    const version = await getVersion(`v:reviews:following:${userId}`);
    const cacheKey = useCursorPagination && cursorParam
      ? `reviews:following:${userId}:v${version}:limit=${limit}:cursor=${cursorParam}`
      : `reviews:following:${userId}:v${version}:limit=${limit}:offset=${offset}`;

    const { value: responseData, hit } = await cacheGetOrSetJSON(cacheKey, 120, async () => {
      const followingIds: string[] = [];
      const FOLLOW_PAGE = 500;
      let followOffset = 0;
      let hasMoreFollows = true;

      while (hasMoreFollows) {
        const followRes = await hasuraQuery(GET_FOLLOWING_LIST, {
          userId,
          limit: FOLLOW_PAGE,
          offset: followOffset,
        });

        if (followRes.errors) {
          const hasTableError = followRes.errors.some((err: any) =>
            err.message?.includes('restaurant_user_follows') ||
            err.message?.includes('not found') ||
            err.message?.includes('relationship')
          );
          if (hasTableError) {
            return { success: true, data: [], meta: { total: 0, limit, offset, hasMore: false } };
          }
          throw new Error(followRes.errors[0]?.message || 'Failed to fetch following list');
        }

        const follows = followRes.data?.restaurant_user_follows || [];
        const ids = follows.map((f: any) => f.user_id).filter(Boolean);
        followingIds.push(...ids);
        followOffset += ids.length;
        hasMoreFollows = ids.length === FOLLOW_PAGE;
        if (followingIds.length >= BATCH_FOLLOWING_MAX) hasMoreFollows = false;
      }

      if (followingIds.length === 0) {
        return { success: true, data: [], meta: { total: 0, limit, offset, hasMore: false } };
      }

      const cappedIds = followingIds.slice(0, BATCH_FOLLOWING_MAX);
      let reviews: any[];
      let total: number;

      if (useCursorPagination && decodedCursor) {
        const r = await hasuraQuery(GET_REVIEWS_BY_AUTHORS_CURSOR, {
          authorIds: cappedIds,
          limit,
          cursorCreatedAt: decodedCursor.created_at,
          cursorId: decodedCursor.id,
        });
        if (r.errors) throw new Error(r.errors[0]?.message || 'Failed to fetch feed');
        reviews = r.data?.restaurant_reviews || [];
        total = 0;
      } else {
        const r = await hasuraQuery(GET_REVIEWS_BY_AUTHORS, { authorIds: cappedIds, limit, offset });
        if (r.errors) throw new Error(r.errors[0]?.message || 'Failed to fetch feed');
        reviews = r.data?.restaurant_reviews || [];
        total = r.data?.restaurant_reviews_aggregate?.aggregate?.count || 0;
      }

      const restaurantUuids = [...new Set(reviews.map((r: any) => r.restaurant_uuid).filter(Boolean))];
      const authorIds = [...new Set(reviews.map((r: any) => r.author_id).filter(Boolean))];

      const [restaurantsResult, authorsResult] = await Promise.allSettled([
        restaurantUuids.length > 0
          ? hasuraQuery(GET_RESTAURANTS_BY_UUIDS, { uuids: restaurantUuids, limit: BATCH_RESTAURANTS_MAX })
          : Promise.resolve({ data: { restaurants: [] }, errors: undefined }),
        authorIds.length > 0
          ? hasuraQuery(GET_RESTAURANT_USERS_BY_IDS, { ids: authorIds, limit: BATCH_USERS_MAX })
          : Promise.resolve({ data: { restaurant_users: [] }, errors: undefined }),
      ]);

      const restaurantMap = new Map<string, any>();
      if (restaurantsResult.status === 'fulfilled' && !restaurantsResult.value.errors) {
        for (const r of restaurantsResult.value.data?.restaurants || []) {
          restaurantMap.set(r.uuid, r);
        }
      }

      const authorMap = new Map<string, any>();
      if (authorsResult.status === 'fulfilled' && !authorsResult.value.errors) {
        for (const u of authorsResult.value.data?.restaurant_users || []) {
          authorMap.set(u.id, u);
        }
      }

      const enrichedReviews = reviews.map((r: any) => ({
        ...r,
        author: authorMap.get(r.author_id) || null,
        restaurant: restaurantMap.get(r.restaurant_uuid) || null,
      }));

      const last = enrichedReviews[enrichedReviews.length - 1];
      const nextCursor = last ? encodeReviewCursor(last.created_at, last.id) : null;
      const hasMore = useCursorPagination ? reviews.length === limit : offset + limit < total;

      return {
        success: true,
        data: enrichedReviews,
        meta: {
          ...(useCursorPagination ? {} : { total }),
          limit,
          ...(!useCursorPagination && { offset }),
          cursor: nextCursor ?? undefined,
          hasMore,
        },
      };
    });

    res
      .set('X-Cache', hit ? 'HIT' : 'MISS')
      .set('Cache-Control', 'private, max-age=0, s-maxage=60, stale-while-revalidate=120')
      .json(responseData);
  } catch (error: any) {
    console.error('[reviews/following-feed] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

import type { Request, Response } from 'express';
import { hasuraQuery } from '../_lib/hasura-client';
import { cacheGetOrSetJSON } from '../_lib/cache';
import { getVersion } from '../_lib/versioning';
import { decodeRestaurantCursor, encodeRestaurantCursor } from '../_lib/cursor-pagination';
import { GET_RESTAURANTS_LIST, GET_SMART_SORT_SUMMARIES } from '../_lib/graphql/restaurant-queries';
import { createHash } from 'crypto';

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const q = req.query;
  const limit = Math.min(parseInt((q.limit as string) || '100', 10), 1000);
  const offsetParam = q.offset as string | undefined;
  const cursorParam = q.cursor as string | undefined;
  const status = (q.status as string) || 'publish';
  const search = q.search as string | undefined;
  const cuisineIds = q.cuisine_ids as string | undefined;
  const cuisineSlugs = q.cuisine_slugs as string | undefined;
  const palateIds = q.palate_ids as string | undefined;
  const palateSlugs = q.palate_slugs as string | undefined;
  const categoryIds = q.category_ids as string | undefined;
  const priceRangeId = q.price_range_id as string | undefined;
  const minRating = q.min_rating as string | undefined;
  const maxRating = q.max_rating as string | undefined;
  const latitude = q.latitude as string | undefined;
  const longitude = q.longitude as string | undefined;
  const radiusKm = q.radius_km as string | undefined;
  const isMainLocation = q.is_main_location as string | undefined;
  const cityName = q.city_name as string | undefined;
  const countryShort = q.country_short as string | undefined;
  const orderBy = q.order_by as string | undefined;

  if (limit < 1 || limit > 1000) {
    res.status(400).json({ success: false, error: 'Limit must be between 1 and 1000' });
    return;
  }

  const decodedCursor = cursorParam ? decodeRestaurantCursor(cursorParam) : null;
  const offset = parseInt(offsetParam || '0', 10);

  const whereConditions: any[] = [{ status: { _eq: status } }];

  if (search) {
    whereConditions.push({
      _or: [
        { title: { _ilike: `%${search}%` } },
        { slug: { _ilike: `%${search}%` } },
        { listing_street: { _ilike: `%${search}%` } },
      ],
    });
  }

  if (cuisineIds) {
    const ids = cuisineIds.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id));
    if (ids.length > 0) whereConditions.push({ _or: ids.map((id) => ({ cuisines: { _contains: [{ id }] } })) });
  }

  if (cuisineSlugs) {
    const slugs = cuisineSlugs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (slugs.length > 0) whereConditions.push({ _or: slugs.map((slug) => ({ cuisines: { _contains: [{ slug }] } })) });
  }

  if (palateIds) {
    const ids = palateIds.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id));
    if (ids.length > 0) whereConditions.push({ _or: ids.map((id) => ({ palates: { _contains: [{ id }] } })) });
  }

  if (palateSlugs) {
    const slugs = palateSlugs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (slugs.length > 0) whereConditions.push({ _or: slugs.map((slug) => ({ palates: { _contains: [{ slug }] } })) });
  }

  if (categoryIds) {
    const ids = categoryIds.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id));
    if (ids.length > 0) whereConditions.push({ _or: ids.map((id) => ({ categories: { _contains: [{ id }] } })) });
  }

  if (priceRangeId) {
    const n = parseInt(priceRangeId, 10);
    if (!isNaN(n)) whereConditions.push({ price_range_id: { _eq: n } });
  }

  if (minRating) {
    const n = parseFloat(minRating);
    if (!isNaN(n)) whereConditions.push({ average_rating: { _gte: n } });
  }

  if (maxRating) {
    const n = parseFloat(maxRating);
    if (!isNaN(n)) whereConditions.push({ average_rating: { _lte: n } });
  }

  if (cityName) whereConditions.push({ address: { _contains: { city: cityName } } });
  if (countryShort) whereConditions.push({ address: { _contains: { country_short: countryShort } } });
  if (isMainLocation === 'true') whereConditions.push({ is_main_location: { _eq: true } });
  else if (isMainLocation === 'false') whereConditions.push({ is_main_location: { _eq: false } });

  const orderByIsCreatedAt = !orderBy || orderBy === 'created_at';
  const canUseCursor = !!decodedCursor && orderByIsCreatedAt;

  let orderByClause: any = { created_at: 'desc' };
  switch (orderBy) {
    case 'rating': orderByClause = { average_rating: 'desc_nulls_last' }; break;
    case 'rating_asc': orderByClause = { average_rating: 'asc_nulls_last' }; break;
    case 'price': orderByClause = { price_range_id: 'asc_nulls_last' }; break;
    case 'updated_at': orderByClause = { updated_at: 'desc' }; break;
    default: orderByClause = { created_at: 'desc' };
  }

  let where: any =
    whereConditions.length === 1 ? whereConditions[0] : { _and: whereConditions };

  if (canUseCursor && decodedCursor) {
    const cursorCond = {
      _or: [
        { created_at: { _lt: decodedCursor.created_at } },
        { _and: [{ created_at: { _eq: decodedCursor.created_at } }, { id: { _lt: decodedCursor.id } }] },
      ],
    };
    where = { _and: [where, cursorCond] };
  }

  try {
    const version = await getVersion('v:restaurants:all');
    const reviewVersion = orderBy === 'smart' ? await getVersion('v:reviews:all') : 0;

    const paramsHash = createHash('sha1')
      .update(JSON.stringify({ ...q, limit, offset: canUseCursor ? undefined : offset }))
      .digest('hex');
    const cacheKey = `restaurants:v${version}:rv${reviewVersion}:${paramsHash}`;

    const { value: responseData, hit } = await cacheGetOrSetJSON(cacheKey, 600, async () => {
      const variables = {
        limit,
        offset: canUseCursor ? 0 : offset,
        where,
        order_by: orderByIsCreatedAt
          ? [{ created_at: 'desc' }, { id: 'desc' }]
          : [orderByClause],
      };

      const result = await hasuraQuery(GET_RESTAURANTS_LIST, variables);
      if (result.errors) throw new Error(result.errors[0]?.message || 'GraphQL error');

      let restaurants: any[] = result.data?.restaurants || [];
      const total = result.data?.restaurants_aggregate?.aggregate?.count || restaurants.length;

      if (orderBy === 'smart') {
        const summaryResult = await hasuraQuery<{
          restaurant_rating_summary: Array<{ restaurant_id: number; authentic_rating_weighted: number | null }>;
        }>(GET_SMART_SORT_SUMMARIES);

        if (!summaryResult.errors && summaryResult.data?.restaurant_rating_summary) {
          const weightMap = new Map(
            summaryResult.data.restaurant_rating_summary.map((r) => [r.restaurant_id, r.authentic_rating_weighted ?? 0])
          );
          const withScore = restaurants.filter((r: any) => weightMap.has(r.id));
          withScore.sort((a: any, b: any) => (weightMap.get(b.id) ?? 0) - (weightMap.get(a.id) ?? 0));
          return {
            success: true,
            data: withScore,
            meta: { total: withScore.length, limit, offset, cursor: undefined, hasMore: false, fetchedAt: new Date().toISOString() },
          };
        }
      }

      if (orderBy === 'distance' && latitude && longitude) {
        const lat = parseFloat(latitude);
        const lon = parseFloat(longitude);
        if (!isNaN(lat) && !isNaN(lon)) {
          restaurants = [...restaurants].sort((a, b) => {
            if (!a.latitude || !a.longitude || !b.latitude || !b.longitude) return 0;
            return calculateDistance(lat, lon, a.latitude, a.longitude) - calculateDistance(lat, lon, b.latitude, b.longitude);
          });
        }
      }

      if (latitude && longitude && radiusKm) {
        const lat = parseFloat(latitude);
        const lon = parseFloat(longitude);
        const radius = parseFloat(radiusKm);
        if (!isNaN(lat) && !isNaN(lon) && radius > 0) {
          restaurants = restaurants.filter((r: any) => {
            if (!r.latitude || !r.longitude) return false;
            return calculateDistance(lat, lon, r.latitude, r.longitude) <= radius;
          });
        }
      }

      const last = restaurants[restaurants.length - 1];
      const nextCursor =
        canUseCursor && last?.created_at != null && last?.id != null
          ? encodeRestaurantCursor(last.created_at, last.id)
          : undefined;
      const hasMore = canUseCursor ? restaurants.length === limit : offset + limit < total;

      return {
        success: true,
        data: restaurants,
        meta: {
          ...(canUseCursor ? {} : { total }),
          limit,
          ...(!canUseCursor && { offset }),
          cursor: nextCursor,
          hasMore,
          fetchedAt: new Date().toISOString(),
        },
      };
    });

    res
      .set('X-Cache', hit ? 'HIT' : 'MISS')
      .set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200')
      .json(responseData);
  } catch (error: any) {
    console.error('[restaurants/search] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

import { hasuraMutation, hasuraQuery } from './hasura-client';
import { hasMatchingPalates, normalizePalates } from './palate-utils';

const GLOBAL_MEAN = 4.0;
const CONFIDENCE_M = 5;

function bayesianWeighted(avg: number, count: number): number {
  return Number((((avg * count) + (GLOBAL_MEAN * CONFIDENCE_M)) / (count + CONFIDENCE_M)).toFixed(4));
}

const GET_REVIEWS_FOR_REBUILD = `
  query RebuildGetReviews($restaurantUuid: uuid!) {
    restaurant_reviews(
      where: {
        restaurant_uuid: { _eq: $restaurantUuid }
        deleted_at: { _is_null: true }
        parent_review_id: { _is_null: true }
      }
    ) {
      rating
      status
      palates
      AuthorProfile {
        palates
      }
    }
  }
`;

const GET_RESTAURANT_FOR_REBUILD = `
  query RebuildGetRestaurant($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) {
      id
      palates
      cuisines
    }
  }
`;

const UPSERT_RATING_SUMMARY = `
  mutation RebuildUpsertRatingSummary($object: restaurant_rating_summary_insert_input!) {
    insert_restaurant_rating_summary_one(
      object: $object
      on_conflict: {
        constraint: restaurant_rating_summary_pkey
        update_columns: [
          overall_review_count overall_rating_sum overall_rating_avg overall_rating_weighted
          authentic_review_count authentic_rating_sum authentic_rating_avg authentic_rating_weighted
          review_version updated_at
        ]
      }
    ) { restaurant_id }
  }
`;

const UPSERT_CUISINE_RATING_SUMMARY = `
  mutation RebuildUpsertCuisineRatingSummaries($objects: [restaurant_cuisine_rating_summary_insert_input!]!) {
    insert_restaurant_cuisine_rating_summary(
      objects: $objects
      on_conflict: {
        constraint: restaurant_cuisine_rating_summary_pkey
        update_columns: [
          search_review_count search_rating_sum search_rating_avg search_rating_weighted
          authentic_review_count authentic_rating_sum authentic_rating_avg authentic_rating_weighted
          review_version updated_at
        ]
      }
    ) { affected_rows }
  }
`;

const UPDATE_RESTAURANT_RATING = `
  mutation RebuildUpdateRestaurantRating($uuid: uuid!, $average_rating: numeric, $ratings_count: Int!) {
    update_restaurants(
      where: { uuid: { _eq: $uuid } }
      _set: { average_rating: $average_rating, ratings_count: $ratings_count }
    ) { affected_rows }
  }
`;

function extractCuisineIds(cuisines: unknown): number[] {
  if (!cuisines) return [];
  const arr = Array.isArray(cuisines) ? cuisines : (() => {
    try { return JSON.parse(String(cuisines)); } catch { return []; }
  })();
  return (arr as unknown[])
    .map((c) => {
      if (typeof c === 'object' && c !== null && 'id' in c) return Number((c as any).id);
      return NaN;
    })
    .filter((id) => !isNaN(id) && id > 0);
}

function extractReviewPalates(palates: unknown): string[] {
  if (!palates) return [];
  if (Array.isArray(palates)) {
    if (palates.every((p) => typeof p === 'string')) {
      return palates.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
    }
    return palates
      .map((p) =>
        typeof p === 'string'
          ? p
          : (p as any)?.slug || (p as any)?.name || ''
      )
      .filter(Boolean)
      .map((p) => p.trim().toLowerCase());
  }
  if (typeof palates === 'string') {
    try { return extractReviewPalates(JSON.parse(palates)); } catch {
      return palates.split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  }
  return [];
}

export async function rebuildRatingSummary(restaurantUuid: string): Promise<void> {
  const [reviewsResult, restaurantResult] = await Promise.all([
    hasuraQuery<{
      restaurant_reviews: Array<{
        rating: number;
        status: string;
        palates: unknown;
        AuthorProfile?: { palates: unknown } | null;
      }>;
    }>(GET_REVIEWS_FOR_REBUILD, { restaurantUuid }),
    hasuraQuery<{ restaurants: Array<{ id: number; palates: unknown; cuisines: unknown }> }>(
      GET_RESTAURANT_FOR_REBUILD,
      { uuid: restaurantUuid }
    ),
  ]);

  if (reviewsResult.errors || restaurantResult.errors) {
    console.error('[rebuildRatingSummary] Query error:', reviewsResult.errors || restaurantResult.errors);
    return;
  }

  const restaurant = restaurantResult.data?.restaurants?.[0];
  if (!restaurant) return;

  const restaurantTaxonomy = [
    ...normalizePalates(restaurant.palates as any),
    ...normalizePalates(restaurant.cuisines as any),
  ];

  const overall = { sum: 0, count: 0 };
  const authentic = { sum: 0, count: 0 };

  for (const review of reviewsResult.data?.restaurant_reviews ?? []) {
    if (review.status !== 'approved') continue;
    const rating = Number(review.rating) || 0;
    if (rating <= 0) continue;
    overall.sum += rating;
    overall.count += 1;

    const authorPalates = extractReviewPalates(review.AuthorProfile?.palates);
    const reviewerPalates = authorPalates.length > 0 ? authorPalates : extractReviewPalates(review.palates);
    if (restaurantTaxonomy.length > 0 && hasMatchingPalates(restaurantTaxonomy, reviewerPalates)) {
      authentic.sum += rating;
      authentic.count += 1;
    }
  }

  const overallAvg = overall.count > 0 ? overall.sum / overall.count : null;
  const overallWeighted = overallAvg !== null ? bayesianWeighted(overallAvg, overall.count) : null;
  const authenticAvg = authentic.count > 0 ? authentic.sum / authentic.count : null;
  const authenticWeighted = authenticAvg !== null ? bayesianWeighted(authenticAvg, authentic.count) : null;

  await hasuraMutation(UPSERT_RATING_SUMMARY, {
    object: {
      restaurant_id: restaurant.id,
      overall_review_count: overall.count,
      overall_rating_sum: Number(overall.sum.toFixed(4)),
      overall_rating_avg: overallAvg !== null ? Number(overallAvg.toFixed(4)) : null,
      overall_rating_weighted: overallWeighted,
      authentic_review_count: authentic.count,
      authentic_rating_sum: Number(authentic.sum.toFixed(4)),
      authentic_rating_avg: authenticAvg !== null ? Number(authenticAvg.toFixed(4)) : null,
      authentic_rating_weighted: authenticWeighted,
      review_version: Math.floor(Date.now() / 1000),
      updated_at: new Date().toISOString(),
    },
  });

  await hasuraMutation(UPDATE_RESTAURANT_RATING, {
    uuid: restaurantUuid,
    average_rating: overallAvg !== null ? Number(overallAvg.toFixed(4)) : null,
    ratings_count: overall.count,
  });

  const cuisineIds = extractCuisineIds(restaurant.cuisines);
  if (cuisineIds.length > 0) {
    const versionTs = Math.floor(Date.now() / 1000);
    const cuisineObjects = cuisineIds.map((cuisineId) => ({
      restaurant_id: restaurant.id,
      cuisine_id: cuisineId,
      search_review_count: overall.count,
      search_rating_sum: Number(overall.sum.toFixed(4)),
      search_rating_avg: overallAvg !== null ? Number(overallAvg.toFixed(4)) : null,
      search_rating_weighted: overallWeighted,
      authentic_review_count: authentic.count,
      authentic_rating_sum: Number(authentic.sum.toFixed(4)),
      authentic_rating_avg: authenticAvg !== null ? Number(authenticAvg.toFixed(4)) : null,
      authentic_rating_weighted: authenticWeighted,
      review_version: versionTs,
      updated_at: new Date().toISOString(),
    }));
    await hasuraMutation(UPSERT_CUISINE_RATING_SUMMARY, { objects: cuisineObjects }).catch((e) =>
      console.warn('[rebuildRatingSummary] Cuisine summary error (non-fatal):', e)
    );
  }
}

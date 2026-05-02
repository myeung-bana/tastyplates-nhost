import type { Request, Response } from 'express';
import { hasuraQuery } from '../_lib/hasura-client';
import {
  MATCH_RESTAURANT_BY_PLACE_ID,
  MATCH_RESTAURANT_BY_NAME_ADDRESS,
} from '../_lib/graphql/restaurant-queries';

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  try {
    const { place_id, name, address, latitude, longitude } = req.body || {};

    if (place_id) {
      const result = await hasuraQuery(MATCH_RESTAURANT_BY_PLACE_ID, { placeId: place_id });
      if (result.data?.restaurants?.length > 0) {
        return void res.json({ match: true, restaurant: result.data.restaurants[0], matchType: 'place_id' });
      }
    }

    if (name && address) {
      const addressPart = address.split(',')[0].trim();
      const result = await hasuraQuery(MATCH_RESTAURANT_BY_NAME_ADDRESS, {
        name: `%${name}%`,
        address: `%${addressPart}%`,
      });
      if (result.data?.restaurants?.length > 0) {
        return void res.json({ match: true, restaurant: result.data.restaurants[0], matchType: 'name_address' });
      }
    }

    if (latitude && longitude) {
      const result = await hasuraQuery(
        `
        query MatchByCoords {
          restaurants(where: { _and: [{ latitude: { _is_null: false } }, { longitude: { _is_null: false } }] }) {
            id uuid title slug status listing_street phone menu_url longitude latitude
            featured_image_url average_rating ratings_count address
          }
        }
      `,
        {}
      );

      if (result.data?.restaurants?.length > 0) {
        let closest: any = null;
        let minDist = Infinity;
        for (const r of result.data.restaurants) {
          if (r.latitude && r.longitude) {
            const dist = calculateDistance(latitude, longitude, r.latitude, r.longitude);
            if (dist < 0.1 && dist < minDist) {
              minDist = dist;
              closest = r;
            }
          }
        }
        if (closest) {
          return void res.json({ match: true, restaurant: closest, matchType: 'coordinates' });
        }
      }
    }

    res.json({ match: false, restaurant: null, matchType: null });
  } catch (error: any) {
    console.error('[restaurants/match] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

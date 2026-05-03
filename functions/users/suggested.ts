import type { Request, Response } from 'express';
import { hasuraQuery } from '../_lib/hasura-client';
import { cacheGetOrSetJSON } from '../_lib/cache';
import { getVersion } from '../_lib/versioning';
import { verifyNhostToken } from '../_lib/auth';

const GET_SUGGESTED_USERS = `
  query GetSuggestedUsers($limit: Int!, $excludeUserId: uuid) {
    restaurant_users(
      where: {
        _and: [
          { id: { _neq: $excludeUserId } }
          { review_count: { _gt: 0 } }
        ]
      }
      order_by: [{ follower_count: desc_nulls_last }, { review_count: desc }]
      limit: $limit
    ) {
      id username display_name profile_image review_count follower_count about_me
    }
  }
`;

function getProfileImageUrl(profileImage: any): string | null {
  if (!profileImage) return null;
  if (typeof profileImage === 'string') return profileImage;
  if (typeof profileImage === 'object') {
    return profileImage.url || profileImage.thumbnail || profileImage.medium || profileImage.large || null;
  }
  return null;
}

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const limit = Math.min(parseInt((req.query.limit as string) || '6', 10), 20);

  let currentUserId: string | null = null;
  const authHeader = req.headers.authorization || null;
  if (authHeader) {
    const tokenResult = await verifyNhostToken(authHeader);
    if (tokenResult.success) currentUserId = tokenResult.userId!;
  }

  try {
    const version = await getVersion('v:users:suggested');
    const cacheKey = `users:suggested:v${version}:limit=${limit}:exclude=${currentUserId || 'none'}`;

    const { value: responseData, hit } = await cacheGetOrSetJSON(cacheKey, 600, async () => {
      const result = await hasuraQuery<{ restaurant_users: any[] }>(GET_SUGGESTED_USERS, {
        limit,
        excludeUserId: currentUserId,
      });

      if (result.errors) {
        throw new Error(result.errors[0]?.message || 'Failed to fetch suggested users');
      }

      const formattedUsers = (result.data?.restaurant_users || []).map((user) => ({
        id: user.id,
        username: user.username,
        name: user.username,
        avatar: getProfileImageUrl(user.profile_image),
        reviewCount: user.review_count || 0,
        followerCount: user.follower_count || 0,
        bio: user.about_me || null,
      }));

      return { success: true, data: { users: formattedUsers, total: formattedUsers.length } };
    });

    res
      .set('X-Cache', hit ? 'HIT' : 'MISS')
      .set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200')
      .json(responseData);
  } catch (error: any) {
    console.error('[users/suggested] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

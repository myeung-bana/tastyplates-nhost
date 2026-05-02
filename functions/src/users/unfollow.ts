import type { Request, Response } from 'express';
import { hasuraMutation, hasuraQuery } from '../_lib/hasura-client';
import { verifyNhostToken } from '../_lib/auth';
import { rateLimitOrThrow, followRateLimit } from '../_lib/rate-limit';
import { UNFOLLOW_USER, GET_FOLLOWERS_COUNT, GET_FOLLOWING_COUNT } from '../_lib/graphql/user-queries';
import { followSchema } from '../_lib/validate';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization || null;
  const tokenResult = await verifyNhostToken(authHeader);
  if (!tokenResult.success) {
    res.status(401).json({ success: false, error: tokenResult.error || 'Authorization required' });
    return;
  }

  const followerId = tokenResult.userId!;

  const rl = await rateLimitOrThrow(followerId, followRateLimit);
  if (!rl.ok) {
    res.status(429).set('Retry-After', String(rl.retryAfter)).json({
      success: false,
      error: 'Rate limit exceeded. Please slow down.',
      retryAfter: rl.retryAfter,
    });
    return;
  }

  const parsed = followSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Invalid user_id' });
    return;
  }

  const userId = parsed.data.user_id;

  if (followerId === userId) {
    res.status(400).json({ success: false, error: 'Cannot unfollow yourself' });
    return;
  }

  try {
    const result = await hasuraMutation(UNFOLLOW_USER, { followerId, userId });

    if (result.errors) {
      console.error('[users/unfollow] GraphQL errors:', result.errors);
      res.status(500).json({ success: false, error: result.errors[0]?.message || 'Failed to unfollow user' });
      return;
    }

    if (result.data?.delete_restaurant_user_follows?.affected_rows === 0) {
      res.status(400).json({ success: false, error: 'Not following this user' });
      return;
    }

    const [followersCountResult, followingCountResult] = await Promise.all([
      hasuraQuery(GET_FOLLOWERS_COUNT, { userId }),
      hasuraQuery(GET_FOLLOWING_COUNT, { userId: followerId }),
    ]);

    res.json({
      success: true,
      data: {
        result: 'unfollowed',
        followers: followersCountResult.data?.restaurant_user_follows_aggregate?.aggregate?.count || 0,
        following: followingCountResult.data?.restaurant_user_follows_aggregate?.aggregate?.count || 0,
      },
    });
  } catch (error: any) {
    console.error('[users/unfollow] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

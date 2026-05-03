import type { Request, Response } from 'express';
import { requireAdminSecret } from '../_lib/auth';
import { redis } from '../_lib/redis';

export default async (req: Request, res: Response): Promise<void> => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const providedSecret = req.headers['x-admin-secret'] as string | undefined;
  if (!requireAdminSecret(providedSecret)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const [restaurantVersion, reviewVersion, restaurantUserVersion] = await Promise.all([
      redis.get<number>('v:restaurants:all'),
      redis.get<number>('v:reviews:all'),
      redis.get<number>('v:users:suggested'),
    ]);

    const nhostAuthUrl =
      process.env.NHOST_AUTH_URL ||
      `https://${process.env.NHOST_SUBDOMAIN}.auth.${process.env.NHOST_REGION}.nhost.run`;

    const hasuraUrl = process.env.NHOST_HASURA_URL || process.env.HASURA_GRAPHQL_API_URL;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'production',
        versions: {
          restaurants: restaurantVersion ?? 0,
          reviews: reviewVersion ?? 0,
          suggestedUsers: restaurantUserVersion ?? 0,
        },
        config: {
          hasuraUrl: hasuraUrl ? `${hasuraUrl.split('//')[1]?.split('/')[0]} (configured)` : 'NOT SET',
          nhostAuthUrl: nhostAuthUrl ? 'configured' : 'NOT SET',
          s3Bucket: process.env.S3_BUCKET_NAME ? 'configured' : 'NOT SET',
          upstashRedis: process.env.UPSTASH_REDIS_REST_URL ? 'configured' : 'NOT SET',
        },
      },
    });
  } catch (error: any) {
    console.error('[admin/monitoring] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
};

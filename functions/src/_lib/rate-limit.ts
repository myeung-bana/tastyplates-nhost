import { Ratelimit } from '@upstash/ratelimit';
import { redis } from './redis';

export const uploadRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '60 s'),
  analytics: true,
  prefix: 'ratelimit:upload',
});

export const likeRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '10 s'),
  analytics: true,
  prefix: 'ratelimit:like',
});

export const createRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '30 s'),
  analytics: true,
  prefix: 'ratelimit:create',
});

export const followRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '10 s'),
  analytics: true,
  prefix: 'ratelimit:follow',
});

export const wishlistRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(15, '10 s'),
  analytics: true,
  prefix: 'ratelimit:wishlist',
});

export const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '10 s'),
  analytics: true,
});

export async function rateLimitOrThrow(
  key: string,
  limiter: Ratelimit = ratelimit
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  try {
    const result = await limiter.limit(key);
    if (!result.success) {
      const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
      return { ok: false, retryAfter };
    }
    return { ok: true };
  } catch (error) {
    console.error(`[rate-limit] Error for key ${key}:`, error);
    return { ok: true };
  }
}

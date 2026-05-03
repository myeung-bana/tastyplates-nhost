import { redis } from './redis';

export async function cacheGetOrSetJSON<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<{ value: T; hit: boolean }> {
  try {
    const cached = await redis.get<T>(key);
    if (cached !== null && cached !== undefined) {
      return { value: cached, hit: true };
    }
    const value = await fn();
    await redis.set(key, value, { ex: ttlSeconds });
    return { value, hit: false };
  } catch (error) {
    console.error(`[cache] Error for key ${key}:`, error);
    const value = await fn();
    return { value, hit: false };
  }
}

export async function cacheGetOrSetJSONNonNull<T extends object>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T | null | undefined>
): Promise<{ value: T | null; hit: boolean }> {
  try {
    const cached = await redis.get<T>(key);
    if (cached !== null && cached !== undefined) {
      return { value: cached, hit: true };
    }
    const value = await fn();
    if (value !== null && value !== undefined) {
      await redis.set(key, value, { ex: ttlSeconds });
    }
    return { value: value ?? null, hit: false };
  } catch (error) {
    console.error(`[cache] Error for key ${key}:`, error);
    const value = await fn();
    return { value: value ?? null, hit: false };
  }
}

export async function cacheInvalidate(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (error) {
    console.error(`[cache] Invalidation error for key ${key}:`, error);
  }
}

import { redis } from './redis';

export async function getVersion(key: string): Promise<number> {
  try {
    const v = await redis.get<number>(key);
    return typeof v === 'number' ? v : 0;
  } catch (error) {
    console.error(`[versioning] getVersion error for key ${key}:`, error);
    return 0;
  }
}

export async function bumpVersion(key: string): Promise<number> {
  try {
    const newVersion = await redis.incr(key);
    return newVersion;
  } catch (error) {
    console.error(`[versioning] bumpVersion error for key ${key}:`, error);
    return 0;
  }
}

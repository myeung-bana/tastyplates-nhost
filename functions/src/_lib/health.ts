import { redis } from './redis';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';

export type ServiceStatus = 'ok' | 'error';

export interface ServiceCheck {
  status: ServiceStatus;
  latencyMs?: number;
  error?: string;
}

export interface HealthResult {
  status: 'healthy' | 'degraded';
  uptime: number;
  checks: {
    hasura: ServiceCheck;
    redis: ServiceCheck;
    s3: ServiceCheck;
  };
}

async function pingHasura(): Promise<ServiceCheck> {
  const url = process.env.NHOST_HASURA_URL || process.env.HASURA_GRAPHQL_API_URL;
  const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

  if (!url) {
    return { status: 'error', error: 'NHOST_HASURA_URL not configured' };
  }

  const start = Date.now();
  try {
    const res = await fetch(`${url}/healthz`, {
      headers: secret ? { 'x-hasura-admin-secret': secret } : {},
      signal: AbortSignal.timeout(4000),
    });
    const latencyMs = Date.now() - start;
    return res.ok
      ? { status: 'ok', latencyMs }
      : { status: 'error', latencyMs, error: `HTTP ${res.status}` };
  } catch (err: any) {
    return { status: 'error', latencyMs: Date.now() - start, error: err.message };
  }
}

async function pingRedis(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    const latencyMs = Date.now() - start;
    return pong === 'PONG'
      ? { status: 'ok', latencyMs }
      : { status: 'error', latencyMs, error: `Unexpected ping response: ${pong}` };
  } catch (err: any) {
    return { status: 'error', latencyMs: Date.now() - start, error: err.message };
  }
}

async function pingS3(): Promise<ServiceCheck> {
  const required = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_BUCKET_NAME'];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    return { status: 'error', error: `Missing S3 env vars: ${missing.join(', ')}` };
  }

  const start = Date.now();
  try {
    const client = new S3Client({
      region: process.env.S3_REGION!,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    });
    await client.send(new ListBucketsCommand({}));
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'error', latencyMs: Date.now() - start, error: err.message };
  }
}

export async function checkHealth(): Promise<HealthResult> {
  const [hasura, redis, s3] = await Promise.all([pingHasura(), pingRedis(), pingS3()]);

  const allOk = hasura.status === 'ok' && redis.status === 'ok' && s3.status === 'ok';

  return {
    status: allOk ? 'healthy' : 'degraded',
    uptime: Math.floor(process.uptime()),
    checks: { hasura, redis, s3 },
  };
}

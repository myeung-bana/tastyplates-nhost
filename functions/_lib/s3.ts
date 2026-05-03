import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';

export function getS3Client(): S3Client {
  const required = {
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_REGION: process.env.S3_REGION,
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing S3 env vars: ${missing.join(', ')}`);
  }

  return new S3Client({
    region: required.S3_REGION!,
    credentials: {
      accessKeyId: required.S3_ACCESS_KEY_ID!,
      secretAccessKey: required.S3_SECRET_ACCESS_KEY!,
    },
  });
}

export function generateFileName(originalName: string, extension: string): string {
  const timestamp = Date.now();
  const random = randomBytes(8).toString('hex');
  const sanitized = originalName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  return `${sanitized}_${timestamp}_${random}.${extension}`;
}

export function buildPublicUrl(s3Key: string): string {
  const bucketName = process.env.S3_BUCKET_NAME!;
  const bucketDomain =
    process.env.S3_BUCKET_DOMAIN ||
    `${bucketName}.s3.${process.env.S3_REGION || 'ap-northeast-2'}.amazonaws.com`;
  return bucketDomain.startsWith('http')
    ? `${bucketDomain}/${s3Key}`
    : `https://${bucketDomain}/${s3Key}`;
}

export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}): Promise<string> {
  const s3 = getS3Client();
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
    ACL: 'public-read',
    Metadata: params.metadata,
  });
  await s3.send(command);
  return buildPublicUrl(params.key);
}

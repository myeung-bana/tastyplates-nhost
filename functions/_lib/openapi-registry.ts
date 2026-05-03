import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  reviewCreateSchema,
  commentCreateSchema,
  reviewUpdateSchema,
  followSchema,
  uuidSchema,
} from './validate';

export const registry = new OpenAPIRegistry();

// ---------------------------------------------------------------------------
// Security scheme
// ---------------------------------------------------------------------------
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const bearerAuth = [{ bearerAuth: [] as string[] }];

// ---------------------------------------------------------------------------
// Reusable response schemas
// ---------------------------------------------------------------------------
const SuccessResponse = (dataShape: z.ZodTypeAny) =>
  z.object({ success: z.literal(true), data: dataShape });

const ErrorResponse = z.object({
  success: z.literal(false),
  error: z.string(),
});

const PaginatedMeta = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().optional(),
});

registry.register('ErrorResponse', ErrorResponse);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
registry.registerPath({
  method: 'post',
  path: '/uploads/image',
  tags: ['Uploads'],
  summary: 'Upload and process a single image',
  description:
    'Accepts a raw image binary (≤ 10 MB). Sharp converts it to AVIF/WebP and stores it in S3. Requires user JWT.',
  security: bearerAuth,
  request: {
    body: {
      content: { 'application/octet-stream': { schema: z.instanceof(Buffer) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Image uploaded successfully',
      content: {
        'application/json': {
          schema: SuccessResponse(z.object({ url: z.string().url(), key: z.string() })),
        },
      },
    },
    429: { description: 'Rate limit exceeded' },
    400: { description: 'Unsupported file type or payload too large' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/uploads/batch',
  tags: ['Uploads'],
  summary: 'Batch upload images to S3 (no Sharp processing)',
  description: 'Upload up to 10 images as base64 JSON. No conversion is applied.',
  security: bearerAuth,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            images: z
              .array(z.object({ name: z.string(), data: z.string(), mimeType: z.string() }))
              .max(10),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Batch upload result',
      content: {
        'application/json': {
          schema: SuccessResponse(
            z.array(z.object({ url: z.string().url(), key: z.string() }))
          ),
        },
      },
    },
    400: { description: 'Bad request' },
    429: { description: 'Rate limit exceeded' },
  },
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
registry.registerPath({
  method: 'post',
  path: '/images/download-google-photo',
  tags: ['Images'],
  summary: 'Download a Google Places photo (CORS proxy)',
  description:
    'Fetches a Google Places photo URL server-side and returns the image binary, bypassing browser CORS restrictions.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ photoUrl: z.string().url() }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: 'Image binary returned with original Content-Type' },
    400: { description: 'Missing or invalid photoUrl' },
    429: { description: 'Rate limit exceeded' },
  },
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------
registry.registerPath({
  method: 'post',
  path: '/reviews/create',
  tags: ['Reviews'],
  summary: 'Create a restaurant review',
  description:
    'Rate-limited (5 per 30 s per user). Triggers rating summary rebuild and cache invalidation.',
  security: bearerAuth,
  request: {
    body: {
      content: { 'application/json': { schema: reviewCreateSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Review created' },
    400: { description: 'Validation error' },
    429: { description: 'Rate limit exceeded' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/reviews/create-comment',
  tags: ['Reviews'],
  summary: 'Add a comment/reply to a review',
  security: bearerAuth,
  request: {
    body: {
      content: { 'application/json': { schema: commentCreateSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Comment created' },
    400: { description: 'Validation error' },
    429: { description: 'Rate limit exceeded' },
  },
});

registry.registerPath({
  method: 'put',
  path: '/reviews/update',
  tags: ['Reviews'],
  summary: 'Update an existing review',
  security: bearerAuth,
  request: {
    body: {
      content: { 'application/json': { schema: reviewUpdateSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Review updated, rating summary rebuilt' },
    400: { description: 'Validation error' },
    403: { description: 'Not owner of review' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/reviews/delete',
  tags: ['Reviews'],
  summary: 'Soft-delete a review',
  security: bearerAuth,
  request: {
    query: z.object({ id: uuidSchema }),
  },
  responses: {
    200: { description: 'Review deleted, rating summary rebuilt' },
    404: { description: 'Review not found' },
    403: { description: 'Not owner of review' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/reviews/following-feed',
  tags: ['Reviews'],
  summary: "Get the authenticated user's following feed",
  description:
    'Returns paginated reviews from users the caller follows. Backed by a Redis composition cache.',
  security: bearerAuth,
  request: {
    query: z.object({
      user_id: uuidSchema,
      limit: z.string().optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Following feed',
      content: {
        'application/json': {
          schema: SuccessResponse(
            z.object({
              reviews: z.array(z.any()),
              meta: PaginatedMeta,
            })
          ),
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
registry.registerPath({
  method: 'get',
  path: '/users/me',
  tags: ['Users'],
  summary: "Get the current user's profile",
  description: 'Decodes the Bearer JWT and returns the matching restaurant_users row.',
  security: bearerAuth,
  responses: {
    200: { description: 'User profile' },
    401: { description: 'Missing or invalid token' },
    404: { description: 'User not found' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/users/follow',
  tags: ['Users'],
  summary: 'Follow a user',
  description: 'Rate-limited. Inserts a restaurant_user_follows row.',
  security: bearerAuth,
  request: {
    body: {
      content: { 'application/json': { schema: followSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Follow recorded' },
    400: { description: 'Cannot follow yourself or already following' },
    429: { description: 'Rate limit exceeded' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/users/unfollow',
  tags: ['Users'],
  summary: 'Unfollow a user',
  security: bearerAuth,
  request: {
    body: {
      content: { 'application/json': { schema: followSchema } },
      required: true,
    },
  },
  responses: {
    200: { description: 'Unfollowed' },
    429: { description: 'Rate limit exceeded' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/users/suggested',
  tags: ['Users'],
  summary: 'Get suggested users to follow',
  description: 'Ranked by follower + review counts. Cached in Redis.',
  request: {
    query: z.object({ limit: z.string().optional() }),
  },
  responses: {
    200: {
      description: 'Suggested users list',
      content: {
        'application/json': {
          schema: SuccessResponse(z.array(z.any())),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/users/delete',
  tags: ['Users'],
  summary: 'Delete own account',
  description: 'Soft-deletes by default. Pass `hard_delete=true` to permanently remove the account.',
  security: bearerAuth,
  request: {
    query: z.object({ id: uuidSchema, hard_delete: z.string().optional() }),
  },
  responses: {
    200: { description: 'Account deleted' },
    403: { description: "Cannot delete another user's account" },
    404: { description: 'User not found' },
  },
});

// ---------------------------------------------------------------------------
// Restaurants
// ---------------------------------------------------------------------------
registry.registerPath({
  method: 'get',
  path: '/restaurants/search',
  tags: ['Restaurants'],
  summary: 'Search restaurants with filters and sorting',
  description:
    'Supports keyword search, cuisine/district filters, smart and distance sort. Results cached in Redis with cursor-based pagination.',
  request: {
    query: z.object({
      q: z.string().optional(),
      cuisine: z.string().optional(),
      district: z.string().optional(),
      sort: z.enum(['smart', 'distance', 'rating', 'newest']).optional(),
      lat: z.string().optional(),
      lng: z.string().optional(),
      limit: z.string().optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated restaurant results',
      content: {
        'application/json': {
          schema: SuccessResponse(
            z.object({
              restaurants: z.array(z.any()),
              meta: PaginatedMeta,
            })
          ),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/restaurants/match',
  tags: ['Restaurants'],
  summary: 'Match a restaurant by Google Place ID, name/address, or coordinates',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            place_id: z.string().optional(),
            name: z.string().optional(),
            address: z.string().optional(),
            lat: z.number().optional(),
            lng: z.number().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: 'Matched restaurant or null' },
    400: { description: 'No search criteria provided' },
  },
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
registry.registerPath({
  method: 'post',
  path: '/admin/backfill-rating-summary',
  tags: ['Admin'],
  summary: 'Rebuild all restaurant rating summaries',
  description: 'Admin only (requires admin role JWT or admin secret header).',
  security: bearerAuth,
  responses: {
    200: { description: 'Backfill completed with count of rebuilt summaries' },
    403: { description: 'Admin access required' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/monitoring',
  tags: ['Admin'],
  summary: 'Operational monitoring snapshot',
  description: 'Returns Redis cache version snapshot and system stats. Admin only.',
  security: bearerAuth,
  responses: {
    200: { description: 'Monitoring data' },
    403: { description: 'Admin access required' },
  },
});

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
export function generateOpenAPISpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Tastyplates Backend API',
      version: '1.0.0',
      description:
        'Nhost Functions powering the Tastyplates platform. Covers uploads, reviews, users, restaurants, and admin operations.',
      contact: { name: 'Tastyplates Engineering' },
    },
    servers: [
      {
        url: 'https://{subdomain}.functions.{region}.nhost.run/v0',
        description: 'Nhost production',
        variables: {
          subdomain: { default: 'ygmkmxorcapgpimwerpc' },
          region: { default: 'ap-southeast-1' },
        },
      },
      { url: 'http://localhost:3001/v0', description: 'Local dev (standalone)' },
    ],
  });
}

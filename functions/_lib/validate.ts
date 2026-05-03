import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

/** Required so `@asteasolutions/zod-to-openapi` can call `.openapi()` on these schemas. */
extendZodWithOpenApi(z);

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidSchema = z.string().regex(UUID_REGEX, 'Invalid UUID format');

export const reviewCreateSchema = z.object({
  restaurant_uuid: uuidSchema,
  author_id: uuidSchema,
  title: z.string().max(500).optional().nullable(),
  content: z.string().min(10),
  rating: z.number().min(0).max(5),
  images: z.array(z.object({ id: z.string(), url: z.string() })).optional().default([]),
  palates: z.array(z.any()).optional().default([]),
  hashtags: z.array(z.string()).optional().default([]),
  mentions: z.array(z.any()).optional().default([]),
  recognitions: z.array(z.any()).optional().default([]),
  status: z.enum(['draft', 'pending', 'approved']).optional().default('draft'),
  parent_review_id: uuidSchema.optional().nullable(),
});

export const commentCreateSchema = z.object({
  parent_review_id: uuidSchema,
  author_id: uuidSchema,
  content: z.string().min(1).max(1000),
  restaurant_uuid: uuidSchema.optional(),
});

export const reviewUpdateSchema = z.object({
  id: uuidSchema,
  title: z.string().max(500).optional().nullable(),
  content: z.string().min(10).optional(),
  rating: z.number().min(0).max(5).optional(),
  images: z.array(z.object({ id: z.string(), url: z.string() })).optional().nullable(),
  palates: z.array(z.any()).optional().nullable(),
  hashtags: z.array(z.string()).optional().nullable(),
  mentions: z.array(z.any()).optional().nullable(),
  recognitions: z.array(z.any()).optional().nullable(),
  status: z.enum(['draft', 'pending', 'approved']).optional(),
});

export const followSchema = z.object({
  user_id: uuidSchema,
});

export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;
export type ReviewUpdateInput = z.infer<typeof reviewUpdateSchema>;

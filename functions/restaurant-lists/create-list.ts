/**
 * POST /v1/restaurant-lists/create-list
 *
 * Body: { title: string, description?: string, is_public?: boolean }
 * Default is_public: true (public list).
 */
import type { Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { requireAuth, getUserId } from '../_lib/auth'
import { hasuraAdmin } from '../_lib/hasura'
import { ok, fail } from '../_lib/respond'
import { validate } from '../_lib/validate'

const CreateListSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  is_public: z.boolean().default(true),
})

const CHECK_SLUG_EXISTS = `
  query CheckSlugExists($slug: String!) {
    recommended_restaurant_lists(
      where: { slug: { _eq: $slug } }
      limit: 1
    ) { id }
  }
`

const CREATE_LIST = `
  mutation CreateList(
    $ownerId: uuid!, $slug: String!, $title: String!,
    $description: String!, $isPublic: Boolean!, $shareToken: String!
  ) {
    insert_recommended_restaurant_lists_one(object: {
      owner_id: $ownerId
      slug: $slug
      title: $title
      description: $description
      is_public: $isPublic
      share_token: $shareToken
      is_active: true
    }) {
      id uuid slug title description is_public share_token created_at updated_at
    }
  }
`

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function randomSuffix(len = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(len)
  return Array.from(bytes).map((b) => chars[b % chars.length]).join('')
}

async function buildUniqueSlug(base: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${randomSuffix()}`
    type R = { recommended_restaurant_lists: { id: number }[] }
    const r = await hasuraAdmin<R>(CHECK_SLUG_EXISTS, { slug: candidate })
    if ((r.recommended_restaurant_lists ?? []).length === 0) return candidate
  }
  return `${base}-${Date.now()}`
}

export default async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = await requireAuth(req, res)
    if (!payload) return
    const ownerId = getUserId(payload)

    const body = validate(req, res, CreateListSchema)
    if (!body) return

    const slugBase = slugify(body.title) || 'my-list'
    const slug = await buildUniqueSlug(slugBase)
    const shareToken = randomBytes(16).toString('base64url')

    type Result = { insert_recommended_restaurant_lists_one: unknown }
    const data = await hasuraAdmin<Result>(CREATE_LIST, {
      ownerId,
      slug,
      title: body.title,
      description: body.description ?? '',
      isPublic: body.is_public,
      shareToken,
    })

    ok(res, { list: data.insert_recommended_restaurant_lists_one }, 201)
  } catch (error) {
    console.error('[restaurant-lists/create-list]', error)
    fail(res, 'Failed to create list', 500)
  }
}

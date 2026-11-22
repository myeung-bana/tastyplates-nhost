/**
 * Reviewer groups (Stage 1: insight lenses) — pure logic, no I/O.
 *
 * A reviewer group is a named set of cuisine identities (leaf `restaurant_cuisines` rows). Its score
 * at a restaurant is how reviewers from those backgrounds rate it, computed from the Rating Model v3
 * review pool with the same filter Shared uses, so it can't drift from v3.
 *
 * Spec: documentation/ratings/palate-groups.md §1 and §4 (workspace root).
 * Loading and saving live in `reviewerGroupsStore.ts`.
 */
import {
  type CuisineTaxonomy,
  normalizeCuisineSlug,
  type PoolEntry,
  type PoolScore,
  reviewerHasAnyLeaf,
  scorePool,
} from './reviewPool'

export const MAX_ACTIVE_LENSES = 50
export const MIN_GROUP_MEMBERS = 2
export const MAX_GROUP_MEMBERS = 60
/** Same threshold as Shared and Group scores. */
export const GROUP_MIN_REVIEWS = 3

export type ReviewerGroupKind = 'map' | 'lens'
export type ReviewerGroupVisibility = 'insight' | 'user_facing'

export type ReviewerGroup = {
  id: number
  slug: string
  name: string
  description: string | null
  kind: ReviewerGroupKind
  visibility: ReviewerGroupVisibility
  sort_order: number
  is_active: boolean
  member_cuisine_ids: number[]
  created_at?: string
  updated_at?: string
}

export type ReviewerGroupInput = {
  id?: number
  slug?: string
  name?: string
  description?: string | null
  sort_order?: number
  is_active?: boolean
  member_cuisine_ids?: unknown
  kind?: unknown
  visibility?: unknown
}

export type ValidatedGroupInput = {
  id: number | null
  slug: string
  name: string
  description: string | null
  sort_order: number
  is_active: boolean
  member_cuisine_ids: number[]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function slugifyGroupName(name: string): string {
  return normalizeCuisineSlug(name)
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Validate a create/update request. Stage 1 only allows lens groups with insight visibility.
 * `existing` is the stored group when updating (slug is immutable after creation).
 * `activeLensCount` counts active lenses other than this one.
 */
export function validateGroupInput(
  input: ReviewerGroupInput,
  taxonomy: CuisineTaxonomy,
  options: { existing: ReviewerGroup | null; activeLensCount: number },
): { ok: true; value: ValidatedGroupInput } | { ok: false; error: string } {
  const { existing } = options

  if (input.kind !== undefined && input.kind !== 'lens') {
    return { ok: false, error: 'Only lens groups can be created in Stage 1' }
  }
  if (input.visibility !== undefined && input.visibility !== 'insight') {
    return { ok: false, error: 'User-facing groups arrive in a later stage; use visibility "insight"' }
  }
  if (existing && existing.kind !== 'lens') {
    return { ok: false, error: 'Map groups cannot be edited in Stage 1' }
  }

  const name = (input.name ?? existing?.name ?? '').trim()
  if (!name) return { ok: false, error: 'Name is required' }
  if (name.length > 80) return { ok: false, error: 'Name must be 80 characters or fewer' }

  let slug: string
  if (existing) {
    if (input.slug !== undefined && input.slug.trim() !== existing.slug) {
      return { ok: false, error: 'Slug cannot be changed after creation' }
    }
    slug = existing.slug
  } else {
    slug = (input.slug?.trim() || slugifyGroupName(name)).toLowerCase()
    if (!/^[a-z0-9-]+$/.test(slug) || slug.length > 60) {
      return { ok: false, error: 'Slug may only contain lowercase letters, numbers and hyphens (max 60)' }
    }
  }

  const description =
    input.description === undefined ? (existing?.description ?? null) : input.description?.trim() || null

  const sortRaw = input.sort_order ?? existing?.sort_order ?? 0
  const sort_order = Number.isInteger(Number(sortRaw)) ? Number(sortRaw) : 0

  const is_active = input.is_active ?? existing?.is_active ?? true

  // Members: leaf cuisine ids only. Taste slugs and regions are rejected.
  let member_cuisine_ids: number[]
  if (input.member_cuisine_ids === undefined && existing) {
    member_cuisine_ids = existing.member_cuisine_ids
  } else {
    if (!Array.isArray(input.member_cuisine_ids)) {
      return { ok: false, error: 'member_cuisine_ids must be an array of cuisine ids' }
    }
    const ids = [...new Set(input.member_cuisine_ids.map((v) => Number(v)))]
    const invalid: string[] = []
    for (const id of ids) {
      const row = Number.isInteger(id) ? taxonomy.byId.get(id) : undefined
      if (!row) invalid.push(`${id} (unknown cuisine)`)
      else if (row.parent_id == null) invalid.push(`${row.name} (a region, not a cuisine)`)
    }
    if (invalid.length > 0) {
      return { ok: false, error: `Members must be cuisines: ${invalid.join(', ')}` }
    }
    member_cuisine_ids = ids
  }

  if (member_cuisine_ids.length < MIN_GROUP_MEMBERS || member_cuisine_ids.length > MAX_GROUP_MEMBERS) {
    return {
      ok: false,
      error: `A group needs between ${MIN_GROUP_MEMBERS} and ${MAX_GROUP_MEMBERS} cuisines (got ${member_cuisine_ids.length})`,
    }
  }

  const becomingActive = is_active && !(existing?.is_active ?? false)
  if (becomingActive && options.activeLensCount >= MAX_ACTIVE_LENSES) {
    return { ok: false, error: `At most ${MAX_ACTIVE_LENSES} active lens groups are allowed` }
  }

  return {
    ok: true,
    value: { id: existing?.id ?? null, slug, name, description, sort_order, is_active, member_cuisine_ids },
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type GroupMemberScore = {
  cuisine_id: number
  slug: string
  name: string
  avg: number | null
  review_count: number
  native_count: number
  scraped_count: number
}

export type ReviewerGroupScore = {
  pooled: PoolScore
  balanced: { avg: number | null; members_with_reviews: number }
  members: GroupMemberScore[]
  unlocked: boolean
}

const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

/**
 * Score one group at one restaurant.
 * - pooled: v3 weighted average over every member reviewer (each reviewer once) — the group score;
 * - balanced: plain mean of member averages, over members with reviews (admin signal);
 * - members: each member cuisine's own score. A reviewer with two member palates appears under both.
 */
export function scoreReviewerGroup(
  entries: readonly PoolEntry[],
  memberCuisineIds: readonly number[],
  taxonomy: CuisineTaxonomy,
): ReviewerGroupScore {
  const pooled = scorePool(entries, reviewerHasAnyLeaf(memberCuisineIds))

  const rawMemberAvgs: number[] = []
  const members: GroupMemberScore[] = memberCuisineIds.map((cuisineId) => {
    const score = scorePool(entries, reviewerHasAnyLeaf([cuisineId]))
    if (score.review_count > 0 && score.display_avg != null) rawMemberAvgs.push(score.display_avg)
    const row = taxonomy.byId.get(cuisineId)
    return {
      cuisine_id: cuisineId,
      slug: row ? normalizeCuisineSlug(row.slug) : String(cuisineId),
      name: row?.name ?? String(cuisineId),
      avg: round2(score.display_avg),
      review_count: score.review_count,
      native_count: score.native_count,
      scraped_count: score.scraped_count,
    }
  })
  members.sort((a, b) => b.review_count - a.review_count || a.name.localeCompare(b.name))

  const balancedAvg = rawMemberAvgs.length
    ? rawMemberAvgs.reduce((sum, avg) => sum + avg, 0) / rawMemberAvgs.length
    : null

  return {
    pooled,
    balanced: { avg: round2(balancedAvg), members_with_reviews: rawMemberAvgs.length },
    members,
    unlocked: pooled.review_count >= GROUP_MIN_REVIEWS,
  }
}

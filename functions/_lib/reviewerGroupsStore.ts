/**
 * Reviewer groups (Stage 1) — loading, saving and per-restaurant scoring. Admin only.
 *
 * Groups and members are read separately and joined here, so this works with the two tables
 * tracked in Hasura without relationships. Pure logic lives in `reviewerGroups.ts`.
 */
import { hasuraAdmin } from './hasura'
import { loadCuisineTaxonomy, loadReviewPool } from './reviewPoolLoader'
import {
  GROUP_MIN_REVIEWS,
  type ReviewerGroup,
  type ReviewerGroupInput,
  scoreReviewerGroup,
  validateGroupInput,
} from './reviewerGroups'

const GROUP_FIELDS = 'id slug name description kind visibility sort_order is_active created_at updated_at'

const LIST_GROUPS = `
  query ListReviewerGroups($where: reviewer_groups_bool_exp!) {
    reviewer_groups(where: $where, order_by: [{ sort_order: asc }, { name: asc }]) { ${GROUP_FIELDS} }
  }
`

const LIST_MEMBERS = `
  query ListReviewerGroupMembers($groupIds: [Int!]!) {
    reviewer_group_members(
      where: { group_id: { _in: $groupIds } }
      order_by: [{ group_id: asc }, { sort_order: asc }]
    ) { group_id cuisine_id }
  }
`

const COUNT_ACTIVE_LENSES = `
  query CountActiveLenses($excludeId: Int!) {
    reviewer_groups_aggregate(
      where: { is_active: { _eq: true }, kind: { _eq: "lens" }, id: { _neq: $excludeId } }
    ) { aggregate { count } }
  }
`

const INSERT_GROUP = `
  mutation InsertReviewerGroup($object: reviewer_groups_insert_input!) {
    insert_reviewer_groups_one(object: $object) { id }
  }
`

const INSERT_MEMBERS = `
  mutation InsertReviewerGroupMembers($members: [reviewer_group_members_insert_input!]!) {
    insert_reviewer_group_members(objects: $members) { affected_rows }
  }
`

const DELETE_GROUP = `
  mutation DeleteReviewerGroup($id: Int!) {
    delete_reviewer_groups_by_pk(id: $id) { id }
  }
`

// One document = one transaction in Hasura: the group and its member list change together.
const UPDATE_GROUP = `
  mutation UpdateReviewerGroup(
    $id: Int!
    $set: reviewer_groups_set_input!
    $members: [reviewer_group_members_insert_input!]!
  ) {
    update_reviewer_groups_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    delete_reviewer_group_members(where: { group_id: { _eq: $id } }) { affected_rows }
    insert_reviewer_group_members(objects: $members) { affected_rows }
  }
`

type GroupRow = Omit<ReviewerGroup, 'member_cuisine_ids'>

export async function listReviewerGroups(options?: {
  includeInactive?: boolean
  id?: number
}): Promise<ReviewerGroup[]> {
  const where: Record<string, unknown> = {}
  if (!options?.includeInactive) where.is_active = { _eq: true }
  if (options?.id != null) where.id = { _eq: options.id }

  const groups = await hasuraAdmin<{ reviewer_groups: GroupRow[] }>(LIST_GROUPS, { where })
  const rows = groups.reviewer_groups ?? []
  if (rows.length === 0) return []

  const members = await hasuraAdmin<{ reviewer_group_members: Array<{ group_id: number; cuisine_id: number }> }>(
    LIST_MEMBERS,
    { groupIds: rows.map((g) => g.id) },
  )
  const byGroup = new Map<number, number[]>()
  for (const m of members.reviewer_group_members ?? []) {
    const list = byGroup.get(m.group_id) ?? []
    list.push(m.cuisine_id)
    byGroup.set(m.group_id, list)
  }

  return rows.map((g) => ({ ...g, member_cuisine_ids: byGroup.get(g.id) ?? [] }))
}

function friendlyWriteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/reviewer_groups_slug_key|Uniqueness violation/i.test(message)) {
    return new Error('A group with this slug already exists')
  }
  return error instanceof Error ? error : new Error(message)
}

/** Create or update a lens group and replace its members. Throws with a user-readable message. */
export async function saveReviewerGroup(
  input: ReviewerGroupInput,
  actor: string | null,
): Promise<ReviewerGroup> {
  const existing =
    input.id != null ? ((await listReviewerGroups({ includeInactive: true, id: Number(input.id) }))[0] ?? null) : null
  if (input.id != null && !existing) throw new Error('Reviewer group not found')

  const [taxonomy, count] = await Promise.all([
    loadCuisineTaxonomy(),
    hasuraAdmin<{ reviewer_groups_aggregate: { aggregate: { count: number } } }>(COUNT_ACTIVE_LENSES, {
      excludeId: existing?.id ?? -1,
    }),
  ])

  const validated = validateGroupInput(input, taxonomy, {
    existing,
    activeLensCount: count.reviewer_groups_aggregate.aggregate.count,
  })
  if (!validated.ok) throw new Error(validated.error)
  const v = validated.value

  const memberRows = (groupId: number) =>
    v.member_cuisine_ids.map((cuisineId, index) => ({ group_id: groupId, cuisine_id: cuisineId, sort_order: index }))

  try {
    if (existing) {
      await hasuraAdmin(UPDATE_GROUP, {
        id: existing.id,
        set: {
          name: v.name,
          description: v.description,
          sort_order: v.sort_order,
          is_active: v.is_active,
          updated_at: new Date().toISOString(),
        },
        members: memberRows(existing.id),
      })
      return (await listReviewerGroups({ includeInactive: true, id: existing.id }))[0]
    }

    const created = await hasuraAdmin<{ insert_reviewer_groups_one: { id: number } }>(INSERT_GROUP, {
      object: {
        slug: v.slug,
        name: v.name,
        description: v.description,
        kind: 'lens',
        visibility: 'insight',
        sort_order: v.sort_order,
        is_active: v.is_active,
        created_by: actor,
      },
    })
    const id = created.insert_reviewer_groups_one.id
    try {
      await hasuraAdmin(INSERT_MEMBERS, { members: memberRows(id) })
    } catch (error) {
      // Don't leave a group without members behind.
      await hasuraAdmin(DELETE_GROUP, { id }).catch(() => undefined)
      throw error
    }
    return (await listReviewerGroups({ includeInactive: true, id }))[0]
  } catch (error) {
    throw friendlyWriteError(error)
  }
}

/** Every active lens scored at one restaurant, from that restaurant's v3 review pool. */
export async function getRestaurantGroupScores(restaurantUuid: string) {
  const uuid = restaurantUuid.trim()
  const [groups, pool] = await Promise.all([
    listReviewerGroups(),
    loadReviewPool({ restaurantUuids: [uuid] }),
  ])

  const scored = groups
    .filter((g) => g.kind === 'lens')
    .map((group) => {
      const score = scoreReviewerGroup(pool.entries, group.member_cuisine_ids, pool.taxonomy)
      return {
        id: group.id,
        slug: group.slug,
        name: group.name,
        description: group.description,
        member_count: group.member_cuisine_ids.length,
        pooled: {
          avg: score.pooled.display_avg != null ? Math.round(score.pooled.display_avg * 100) / 100 : null,
          ranking_value: score.pooled.ranking_value,
          review_count: score.pooled.review_count,
          reviewer_count: score.pooled.reviewer_count,
          native_count: score.pooled.native_count,
          scraped_count: score.pooled.scraped_count,
          total_weight: score.pooled.total_weight,
        },
        balanced: score.balanced,
        unlocked: score.unlocked,
        members: score.members,
      }
    })
    .sort((a, b) => b.pooled.review_count - a.pooled.review_count || a.name.localeCompare(b.name))

  return {
    restaurant_uuid: uuid,
    min_reviews: GROUP_MIN_REVIEWS,
    pool_reviews: pool.entries.length,
    groups: scored,
  }
}

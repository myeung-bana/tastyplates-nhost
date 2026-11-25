/**
 * Personalised readings — loading, saving and running the job. Pure logic lives in
 * `restaurantReading.ts` (facts, prompt, validation) and `restaurantScores.ts` (detail scores).
 */
import { hasuraAdmin } from './hasura'
import { openRouterChat, OpenRouterConfigError } from './openrouter'
import {
  buildReadingFacts,
  buildReadingPrompt,
  parseJsonObject,
  READING_MIN_REVIEWS,
  type ReadingFacts,
  type ReadingGroupInput,
  type ReadingText,
  regionGroupsFromTaxonomy,
  type ReviewText,
  selectPromptReviews,
  validateReadingText,
} from './restaurantReading'
import {
  type CuisineTaxonomy,
  type PoolEntry,
  resolveReviewerIdentity,
  resolveRestaurantCuisines,
} from './reviewPool'
import { loadCuisineTaxonomy, loadReviewPool } from './reviewPoolLoader'
import { listReviewerGroups } from './reviewerGroupsStore'

/** Readings a user can start per local day (env `READING_DAILY_LIMIT`, default 10). */
export function readingDailyLimit(): number {
  const n = Number(process.env.READING_DAILY_LIMIT)
  return Number.isInteger(n) && n > 0 ? n : 10
}

/** A job that hasn't moved for this long is treated as failed (the function was cut off). */
const STALE_JOB_MS = 3 * 60_000

export type ReadingStatus = 'gathering' | 'grouping' | 'writing' | 'ready' | 'failed'
const RUNNING: ReadonlySet<ReadingStatus> = new Set(['gathering', 'grouping', 'writing'])

export type ReadingRow = {
  id: string
  user_id: string
  restaurant_uuid: string
  reading_date: string
  status: ReadingStatus
  facts: ReadingFacts | null
  content: ReadingText | null
  model: string | null
  error: string | null
  feedback: number | null
  created_at: string
  updated_at: string
}

const READING_FIELDS =
  'id user_id restaurant_uuid reading_date status facts content model error feedback created_at updated_at'

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * The viewer's local calendar day as YYYY-MM-DD. `tzOffsetMinutes` is JavaScript's
 * `Date#getTimezoneOffset()` from the device (UTC minus local, e.g. -480 for UTC+8).
 */
export function localDay(tzOffsetMinutes: number | null | undefined, now = new Date()): string {
  const offset = Number.isFinite(tzOffsetMinutes) && Math.abs(Number(tzOffsetMinutes)) <= 14 * 60 ? Number(tzOffsetMinutes) : 0
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

export function isStale(row: Pick<ReadingRow, 'status' | 'updated_at'>, now = Date.now()): boolean {
  return RUNNING.has(row.status) && now - new Date(row.updated_at).getTime() > STALE_JOB_MS
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const GET_RESTAURANT = `
  query ReadingRestaurant($uuid: uuid!) {
    restaurants(where: { uuid: { _eq: $uuid } }, limit: 1) { uuid title cuisines }
  }
`

const GET_VIEWER_PALATES = `
  query ReadingViewerPalates($userId: bpchar!) {
    user_profiles(where: { user_id: { _eq: $userId } }, limit: 1) { palates }
  }
`

const GET_NATIVE_TEXT = `
  query ReadingNativeText($ids: [uuid!]!) {
    restaurant_reviews(where: { id: { _in: $ids } }) { id title content }
  }
`

const GET_EXTERNAL_TEXT = `
  query ReadingExternalText($ids: [uuid!]!) {
    restaurant_external_reviews(where: { id: { _in: $ids } }) { id body }
  }
`

export type ReadingRestaurant = {
  uuid: string
  title: string
  cuisineLabel: string | null
  cuisines: { leafIds: Set<number>; regionIds: Set<number> }
}

export async function loadRestaurant(uuid: string, taxonomy: CuisineTaxonomy): Promise<ReadingRestaurant | null> {
  const data = await hasuraAdmin<{ restaurants: Array<{ uuid: string; title: string | null; cuisines: unknown }> }>(
    GET_RESTAURANT,
    { uuid },
  )
  const row = data.restaurants?.[0]
  if (!row) return null
  const cuisines = resolveRestaurantCuisines(row.cuisines, taxonomy)
  const firstLeaf = [...cuisines.leafIds][0]
  const firstRegion = [...cuisines.regionIds][0]
  const label = taxonomy.byId.get(firstLeaf ?? firstRegion ?? -1)?.name ?? null
  return { uuid: row.uuid, title: row.title?.trim() || 'this restaurant', cuisineLabel: label, cuisines }
}

/** The viewer's leaf palate ids (empty when none are set). */
export async function loadViewerLeafIds(userId: string, taxonomy: CuisineTaxonomy): Promise<Set<number>> {
  const data = await hasuraAdmin<{ user_profiles: Array<{ palates: unknown }> }>(GET_VIEWER_PALATES, { userId })
  return new Set(resolveReviewerIdentity(data.user_profiles?.[0]?.palates, taxonomy).leafIds)
}

/** Active reviewer groups; falls back to taxonomy regions when none are configured. */
export async function loadReadingGroups(taxonomy: CuisineTaxonomy): Promise<ReadingGroupInput[]> {
  try {
    const groups = (await listReviewerGroups()).filter((g) => g.kind === 'lens' && g.member_cuisine_ids.length > 0)
    if (groups.length > 0) {
      return groups.map((g) => ({ slug: g.slug, name: g.name, member_cuisine_ids: g.member_cuisine_ids }))
    }
  } catch (error) {
    // Reviewer groups not deployed yet — use regions.
    console.warn('[readings] reviewer groups unavailable, using regions:', error instanceof Error ? error.message : error)
  }
  return regionGroupsFromTaxonomy(taxonomy)
}

async function loadReviewTexts(entries: readonly PoolEntry[], viewerLeafIds: ReadonlySet<number>): Promise<ReviewText[]> {
  const native = entries.filter((e) => e.source === 'first_party' && e.reviewId)
  const external = entries.filter((e) => e.source === 'external' && e.reviewId)
  const [nativeRows, externalRows] = await Promise.all([
    native.length
      ? hasuraAdmin<{ restaurant_reviews: Array<{ id: string; title: string | null; content: string | null }> }>(
          GET_NATIVE_TEXT,
          { ids: native.map((e) => e.reviewId) },
        )
      : Promise.resolve({ restaurant_reviews: [] }),
    external.length
      ? hasuraAdmin<{ restaurant_external_reviews: Array<{ id: string; body: string | null }> }>(GET_EXTERNAL_TEXT, {
          ids: external.map((e) => e.reviewId),
        })
      : Promise.resolve({ restaurant_external_reviews: [] }),
  ])

  const textById = new Map<string, string>()
  for (const r of nativeRows.restaurant_reviews ?? []) {
    textById.set(r.id, stripHtml([r.title, r.content].filter(Boolean).join('. ')))
  }
  for (const r of externalRows.restaurant_external_reviews ?? []) textById.set(r.id, stripHtml(r.body ?? ''))

  return entries
    .filter((e) => e.reviewId && textById.get(e.reviewId))
    .map((e) => ({
      id: e.reviewId!,
      source: e.source,
      rating: e.rating,
      text: textById.get(e.reviewId!)!,
      in_circles: [...e.identity.leafIds].some((id) => viewerLeafIds.has(id)),
    }))
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Everything a reading needs, numbers only. */
export async function loadReadingContext(userId: string, restaurantUuid: string) {
  const taxonomy = await loadCuisineTaxonomy()
  const [restaurant, viewerLeafIds, pool, groups] = await Promise.all([
    loadRestaurant(restaurantUuid, taxonomy),
    loadViewerLeafIds(userId, taxonomy),
    loadReviewPool({ restaurantUuids: [restaurantUuid], taxonomy }),
    loadReadingGroups(taxonomy),
  ])
  if (!restaurant) return null
  const facts = buildReadingFacts({
    restaurant: { uuid: restaurant.uuid, title: restaurant.title, cuisine: restaurant.cuisineLabel },
    entries: pool.entries,
    taxonomy,
    viewerLeafIds,
    groups,
  })
  return { restaurant, viewerLeafIds, entries: pool.entries, facts }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export async function getReadingForDay(userId: string, restaurantUuid: string, day: string): Promise<ReadingRow | null> {
  const data = await hasuraAdmin<{ restaurant_readings: ReadingRow[] }>(
    `query ReadingForDay($userId: uuid!, $uuid: uuid!, $day: date!) {
      restaurant_readings(where: { user_id: { _eq: $userId }, restaurant_uuid: { _eq: $uuid }, reading_date: { _eq: $day } }, limit: 1) { ${READING_FIELDS} }
    }`,
    { userId, uuid: restaurantUuid, day },
  )
  return data.restaurant_readings?.[0] ?? null
}

export async function getReadingById(id: string): Promise<ReadingRow | null> {
  const data = await hasuraAdmin<{ restaurant_readings_by_pk: ReadingRow | null }>(
    `query ReadingById($id: uuid!) { restaurant_readings_by_pk(id: $id) { ${READING_FIELDS} } }`,
    { id },
  )
  return data.restaurant_readings_by_pk ?? null
}

export async function countReadingsForDay(userId: string, day: string): Promise<number> {
  const data = await hasuraAdmin<{ restaurant_readings_aggregate: { aggregate: { count: number } } }>(
    `query ReadingsForDay($userId: uuid!, $day: date!) {
      restaurant_readings_aggregate(where: { user_id: { _eq: $userId }, reading_date: { _eq: $day } }) { aggregate { count } }
    }`,
    { userId, day },
  )
  return data.restaurant_readings_aggregate?.aggregate?.count ?? 0
}

async function insertReading(userId: string, restaurantUuid: string, day: string): Promise<ReadingRow> {
  const data = await hasuraAdmin<{ insert_restaurant_readings_one: ReadingRow }>(
    `mutation InsertReading($object: restaurant_readings_insert_input!) {
      insert_restaurant_readings_one(object: $object) { ${READING_FIELDS} }
    }`,
    { object: { user_id: userId, restaurant_uuid: restaurantUuid, reading_date: day, status: 'gathering' } },
  )
  return data.insert_restaurant_readings_one
}

export async function updateReading(id: string, set: Partial<Omit<ReadingRow, 'id'>>): Promise<void> {
  await hasuraAdmin(
    `mutation UpdateReading($id: uuid!, $set: restaurant_readings_set_input!) {
      update_restaurant_readings_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id, set: { ...set, updated_at: new Date().toISOString() } },
  )
}

// ---------------------------------------------------------------------------
// Card state (design: Default · Ready · Not enough · No palates · Guest · Daily limit)
// ---------------------------------------------------------------------------

export type ReadingCardState =
  | 'guest'
  | 'no_palates'
  | 'not_enough'
  | 'daily_limit'
  | 'ready'
  | 'pending'
  | 'default'

export type ReadingStatePayload = {
  state: ReadingCardState
  reading_id: string | null
  updated_at: string | null
  circles_review_count: number
  min_reviews: number
}

export async function resolveReadingState(
  userId: string | null,
  restaurantUuid: string,
  day: string,
): Promise<ReadingStatePayload> {
  const base = { reading_id: null, updated_at: null, circles_review_count: 0, min_reviews: READING_MIN_REVIEWS }
  if (!userId) return { ...base, state: 'guest' }

  const existing = await getReadingForDay(userId, restaurantUuid, day)
  if (existing?.status === 'ready') {
    return {
      ...base,
      state: 'ready',
      reading_id: existing.id,
      updated_at: existing.updated_at,
      circles_review_count: existing.facts?.circles.review_count ?? 0,
    }
  }
  if (existing && !isStale(existing) && existing.status !== 'failed') {
    return { ...base, state: 'pending', reading_id: existing.id, updated_at: existing.updated_at }
  }

  const taxonomy = await loadCuisineTaxonomy()
  const viewerLeafIds = await loadViewerLeafIds(userId, taxonomy)
  if (viewerLeafIds.size === 0) return { ...base, state: 'no_palates' }

  const pool = await loadReviewPool({ restaurantUuids: [restaurantUuid], taxonomy })
  const circles = pool.entries.filter((e) => [...e.identity.leafIds].some((id) => viewerLeafIds.has(id))).length
  if (circles < READING_MIN_REVIEWS) return { ...base, state: 'not_enough', circles_review_count: circles }

  // A failed or stale row for today can be retried without using another reading.
  if (!existing && (await countReadingsForDay(userId, day)) >= readingDailyLimit()) {
    return { ...base, state: 'daily_limit', circles_review_count: circles }
  }
  return { ...base, state: 'default', reading_id: existing?.id ?? null, circles_review_count: circles }
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export class ReadingRefusal extends Error {
  constructor(
    public readonly state: ReadingCardState,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Create (or reuse) today's row and return it straight away; `runReading` does the work.
 * Throws `ReadingRefusal` when the card shouldn't allow a reading.
 */
export async function claimReading(userId: string, restaurantUuid: string, day: string): Promise<{ row: ReadingRow; run: boolean }> {
  const state = await resolveReadingState(userId, restaurantUuid, day)
  if (state.state === 'ready' || state.state === 'pending') {
    const row = await getReadingById(state.reading_id!)
    if (row) return { row, run: false }
  }
  if (state.state !== 'default') {
    const messages: Partial<Record<ReadingCardState, string>> = {
      no_palates: 'Set your palates first',
      not_enough: 'Not enough reviews from your palate yet',
      daily_limit: 'Daily limit reached — try again tomorrow',
      guest: 'Sign in to get a reading',
    }
    throw new ReadingRefusal(state.state, messages[state.state] ?? 'Reading unavailable')
  }

  if (state.reading_id) {
    await updateReading(state.reading_id, { status: 'gathering', error: null })
    const row = await getReadingById(state.reading_id)
    if (row) return { row, run: true }
  }
  try {
    return { row: await insertReading(userId, restaurantUuid, day), run: true }
  } catch (error) {
    // Two taps raced: the unique (user, restaurant, day) row already exists.
    const row = await getReadingForDay(userId, restaurantUuid, day)
    if (row) return { row, run: false }
    throw error
  }
}

/** Run the job for a claimed row, recording each step so the app can follow along. */
export async function runReading(rowId: string, userId: string, restaurantUuid: string): Promise<void> {
  let facts: ReadingFacts | null = null
  try {
    const context = await loadReadingContext(userId, restaurantUuid)
    if (!context) throw new Error('Restaurant not found')
    facts = context.facts
    const reviews = selectPromptReviews(await loadReviewTexts(context.entries, context.viewerLeafIds))

    await updateReading(rowId, { status: 'grouping', facts })

    await updateReading(rowId, { status: 'writing' })
    const prompt = buildReadingPrompt(facts, reviews)
    const reply = await openRouterChat([
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ])
    const content = validateReadingText(parseJsonObject(reply.text), facts, prompt.refs)

    await updateReading(rowId, { status: 'ready', content, model: reply.model, error: null })
  } catch (error) {
    const message =
      error instanceof OpenRouterConfigError
        ? 'Reading service is not configured'
        : error instanceof Error
          ? error.message
          : String(error)
    console.error('[readings/run]', rowId, message)
    // Keep the facts so the error screen can still show group scores.
    await updateReading(rowId, { status: 'failed', error: message.slice(0, 500), ...(facts ? { facts } : {}) }).catch(() => undefined)
  }
}

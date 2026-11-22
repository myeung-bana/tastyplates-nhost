import { describe, expect, it } from 'vitest'

import {
  MAX_ACTIVE_LENSES,
  type ReviewerGroup,
  scoreReviewerGroup,
  slugifyGroupName,
  validateGroupInput,
} from './reviewerGroups'
import { buildCuisineTaxonomy, buildPoolEntries, type NativeReviewRow, type ScrapedReviewRow } from './reviewPool'

const taxonomy = buildCuisineTaxonomy([
  { id: 2229, slug: 'southeast-asia', name: 'Southeast Asia', parent_id: null },
  { id: 2215, slug: 'central-america', name: 'Central America', parent_id: null },
  { id: 2221, slug: 'southern-europe', name: 'Southern Europe', parent_id: null },
  { id: 2217, slug: 'south-america', name: 'South America', parent_id: null },
  { id: 30, slug: 'filipino', name: 'Filipino', parent_id: 2229 },
  { id: 31, slug: 'mexican', name: 'Mexican', parent_id: 2215 },
  { id: 32, slug: 'spanish', name: 'Spanish', parent_id: 2221 },
  { id: 33, slug: 'peruvian', name: 'Peruvian', parent_id: 2217 },
])
const SPANISH_INFLUENCE = [30, 31, 32, 33]
const R = 'b2a7b147-778e-4635-bd54-f3364c6fd717'

let seq = 0
const native = (rating: number, palates: unknown, author_id?: string): NativeReviewRow => {
  seq += 1
  return { id: `n${seq}`, restaurant_uuid: R, rating, status: 'approved', author_id: author_id ?? null, palates }
}
const scraped = (rating: number, author_palates: unknown): ScrapedReviewRow => {
  seq += 1
  return { id: `s${seq}`, restaurant_uuid: R, rating, is_flagged: false, author_palates, source_author_id: `g${seq}` }
}
const pool = (n: NativeReviewRow[], s: ScrapedReviewRow[] = []) =>
  buildPoolEntries({ native: n, scraped: s, profilePalatesByUserId: new Map(), taxonomy })

describe('scoreReviewerGroup', () => {
  // palate-groups.md §1 worked example
  const entries = pool(
    [native(4.5, ['filipino']), native(5, ['filipino']), native(4, ['spanish'])],
    [scraped(3, ['mexican']), scraped(3, ['mexican'])],
  )

  it('pools member reviewers with v3 weights (4.13 from 5 reviews)', () => {
    const score = scoreReviewerGroup(entries, SPANISH_INFLUENCE, taxonomy)
    expect(score.pooled.review_count).toBe(5)
    expect(score.pooled.display_avg).toBeCloseTo(33 / 8, 4)
    expect(Number(score.pooled.display_avg!.toFixed(2))).toBe(4.13)
    expect(score.unlocked).toBe(true)
  })

  it('balanced = mean of member averages, skipping members without reviews (3.92)', () => {
    const score = scoreReviewerGroup(entries, SPANISH_INFLUENCE, taxonomy)
    expect(score.balanced).toEqual({ avg: 3.92, members_with_reviews: 3 })
    const peruvian = score.members.find((m) => m.slug === 'peruvian')!
    expect(peruvian).toMatchObject({ review_count: 0, avg: null })
  })

  it('breaks the score down per member country', () => {
    const score = scoreReviewerGroup(entries, SPANISH_INFLUENCE, taxonomy)
    expect(score.members.map((m) => [m.slug, m.avg, m.review_count])).toEqual([
      ['filipino', 4.75, 2],
      ['mexican', 3, 2],
      ['spanish', 4, 1],
      ['peruvian', null, 0],
    ])
  })

  it('counts a reviewer with two member palates once in the pooled score, under both members', () => {
    const score = scoreReviewerGroup(pool([native(5, ['filipino', 'spanish'], 'u1')]), SPANISH_INFLUENCE, taxonomy)
    expect(score.pooled.review_count).toBe(1)
    expect(score.members.filter((m) => m.review_count === 1).map((m) => m.slug).sort()).toEqual(['filipino', 'spanish'])
  })

  it('stays locked below 3 reviews and ignores reviewers outside the group or without a palate', () => {
    const score = scoreReviewerGroup(
      pool([native(5, ['filipino']), native(1, ['korean'])], [scraped(2, null)]),
      SPANISH_INFLUENCE,
      taxonomy,
    )
    expect(score.pooled.review_count).toBe(1)
    expect(score.unlocked).toBe(false)
  })
})

describe('validateGroupInput', () => {
  const base = { name: 'Spanish influence', member_cuisine_ids: SPANISH_INFLUENCE }
  const opts = { existing: null, activeLensCount: 0 }

  it('creates a lens with a slug derived from the name', () => {
    const result = validateGroupInput(base, taxonomy, opts)
    expect(result.ok && result.value).toMatchObject({ slug: 'spanish-influence', is_active: true, member_cuisine_ids: SPANISH_INFLUENCE })
    expect(slugifyGroupName('Silk Road / Central Asia')).toBe('silk-road-central-asia')
  })

  it('rejects regions, unknown ids and taste slugs as members', () => {
    expect(validateGroupInput({ ...base, member_cuisine_ids: [30, 2229] }, taxonomy, opts)).toMatchObject({ ok: false })
    expect(validateGroupInput({ ...base, member_cuisine_ids: [30, 999] }, taxonomy, opts)).toMatchObject({ ok: false })
    expect(validateGroupInput({ ...base, member_cuisine_ids: [30, 'spicy'] }, taxonomy, opts)).toMatchObject({ ok: false })
  })

  it('enforces member limits and the active lens cap', () => {
    expect(validateGroupInput({ ...base, member_cuisine_ids: [30] }, taxonomy, opts)).toMatchObject({ ok: false })
    expect(validateGroupInput(base, taxonomy, { existing: null, activeLensCount: MAX_ACTIVE_LENSES })).toMatchObject({ ok: false })
    expect(
      validateGroupInput({ ...base, is_active: false }, taxonomy, { existing: null, activeLensCount: MAX_ACTIVE_LENSES }),
    ).toMatchObject({ ok: true })
  })

  it('keeps the slug immutable and only allows lens / insight in Stage 1', () => {
    const existing: ReviewerGroup = {
      id: 1, slug: 'spanish-influence', name: 'Spanish influence', description: null, kind: 'lens',
      visibility: 'insight', sort_order: 0, is_active: true, member_cuisine_ids: SPANISH_INFLUENCE,
    }
    expect(validateGroupInput({ id: 1, slug: 'renamed' }, taxonomy, { existing, activeLensCount: 0 })).toMatchObject({ ok: false })
    const rename = validateGroupInput({ id: 1, name: 'Hispanic influence' }, taxonomy, { existing, activeLensCount: 0 })
    expect(rename.ok && rename.value).toMatchObject({ slug: 'spanish-influence', name: 'Hispanic influence' })
    expect(validateGroupInput({ ...base, kind: 'map' }, taxonomy, opts)).toMatchObject({ ok: false })
    expect(validateGroupInput({ ...base, visibility: 'user_facing' }, taxonomy, opts)).toMatchObject({ ok: false })
  })
})

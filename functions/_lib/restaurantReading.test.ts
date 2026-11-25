import { describe, expect, it } from 'vitest'

import {
  buildReadingFacts,
  buildReadingPrompt,
  confidenceFor,
  fitFor,
  parseJsonObject,
  regionGroupsFromTaxonomy,
  type ReviewText,
  selectPromptReviews,
  validateReadingText,
} from './restaurantReading'
import { computeRestaurantScores } from './restaurantScores'
import { buildCuisineTaxonomy, buildPoolEntries, type NativeReviewRow, type ScrapedReviewRow } from './reviewPool'

const taxonomy = buildCuisineTaxonomy([
  { id: 100, slug: 'east-asian', name: 'East Asian', parent_id: null },
  { id: 200, slug: 'southern-europe', name: 'Southern Europe', parent_id: null },
  { id: 1, slug: 'korean', name: 'Korean', parent_id: 100 },
  { id: 2, slug: 'japanese', name: 'Japanese', parent_id: 100 },
  { id: 3, slug: 'chinese', name: 'Chinese', parent_id: 100 },
  { id: 4, slug: 'italian', name: 'Italian', parent_id: 200 },
])
const R = 'b2a7b147-778e-4635-bd54-f3364c6fd717'

let seq = 0
const native = (rating: number, palates: unknown): NativeReviewRow => {
  seq += 1
  return { id: `n${seq}`, restaurant_uuid: R, rating, status: 'approved', author_id: null, palates }
}
const scraped = (rating: number, author_palates: unknown): ScrapedReviewRow => {
  seq += 1
  return { id: `s${seq}`, restaurant_uuid: R, rating, is_flagged: false, author_palates, source_author_id: `g${seq}` }
}
const pool = (n: NativeReviewRow[], s: ScrapedReviewRow[] = []) =>
  buildPoolEntries({ native: n, scraped: s, profilePalatesByUserId: new Map(), taxonomy })

const KOREAN_PLACE = { leafIds: new Set([1]), regionIds: new Set<number>() }
const JAPANESE_PLACE = { leafIds: new Set([2]), regionIds: new Set<number>() }
const ITALIAN_PLACE = { leafIds: new Set([4]), regionIds: new Set<number>() }

describe('computeRestaurantScores — palate score choice', () => {
  const entries = pool(
    [native(5, ['korean']), native(4, ['korean']), native(4.5, ['korean']), native(3, ['italian'])],
    [scraped(4, ['japanese'])],
  )

  it('guests get Overall and Authentic only', () => {
    const s = computeRestaurantScores({ entries, taxonomy, restaurantCuisines: KOREAN_PLACE, viewerLeafIds: null, groups: [] })
    expect(s.palate).toBeNull()
    expect(s.shared).toBeNull()
    expect(s.overall.review_count).toBe(5)
  })

  it('a matching cuisine gives "Your Score · Korean"', () => {
    const s = computeRestaurantScores({ entries, taxonomy, restaurantCuisines: KOREAN_PLACE, viewerLeafIds: new Set([1]), groups: [] })
    expect(s.palate?.label).toBe('Your Score · Korean')
    expect(s.palate?.kind).toBe('palate')
    expect(s.palate?.review_count).toBe(3)
    expect(s.palate?.unlocked).toBe(true)
    expect(s.palate?.caption).toBe('Reviewers who grew up with Korean food')
  })

  it('the same region gives the region score', () => {
    const s = computeRestaurantScores({ entries, taxonomy, restaurantCuisines: JAPANESE_PLACE, viewerLeafIds: new Set([1]), groups: [] })
    expect(s.palate?.label).toBe('East Asian Score')
    expect(s.palate?.review_count).toBe(4)
  })

  it('falls back to a group holding the viewer cuisine', () => {
    const groups = [{ slug: 'asian-heat', name: 'Asian Heat', member_cuisine_ids: [1, 3] }]
    const s = computeRestaurantScores({ entries, taxonomy, restaurantCuisines: ITALIAN_PLACE, viewerLeafIds: new Set([1]), groups })
    expect(s.palate?.label).toBe('Asian Heat Score')
    expect(s.palate?.kind).toBe('group')
  })

  it('locks Shared under three reviews from the viewer palate', () => {
    const s = computeRestaurantScores({ entries, taxonomy, restaurantCuisines: KOREAN_PLACE, viewerLeafIds: new Set([4]), groups: [] })
    expect(s.shared?.review_count).toBe(1)
    expect(s.shared?.unlocked).toBe(false)
  })
})

describe('reading facts', () => {
  const entries = pool(
    [native(5, ['korean']), native(4, ['korean']), native(4.5, ['japanese']), native(3, ['italian'])],
    [scraped(4, ['korean'])],
  )
  const facts = buildReadingFacts({
    restaurant: { uuid: R, title: 'Hanok House', cuisine: 'Korean' },
    entries,
    taxonomy,
    viewerLeafIds: new Set([1]),
    groups: regionGroupsFromTaxonomy(taxonomy),
  })

  it('splits your groups from other groups with a why line', () => {
    expect(facts.your_groups.map((g) => g.name)).toEqual(['East Asian'])
    expect(facts.your_groups[0]!.why).toBe('You picked Korean, which is part of East Asian.')
    expect(facts.other_groups.map((g) => g.name)).toEqual(['Southern Europe'])
    expect(facts.other_groups[0]!.why).toBeNull()
  })

  it('scores circles from reviewers who share the palate', () => {
    expect(facts.circles.review_count).toBe(3)
    expect(facts.circles.native_count).toBe(2)
    expect(facts.circles.unlocked).toBe(true)
    expect(facts.based_on).toBe(5)
  })

  it('lists member cuisines with their own counts', () => {
    const members = facts.your_groups[0]!.members
    expect(members.find((m) => m.slug === 'korean')?.review_count).toBe(3)
    expect(members.find((m) => m.slug === 'chinese')?.review_count).toBe(0)
  })
})

describe('fit and confidence bands', () => {
  it('only calls a fit once unlocked', () => {
    expect(fitFor(4.6, false)).toBeNull()
    expect(fitFor(4.6, true)?.label).toBe('Strong match')
    expect(fitFor(3.9, true)?.band).toBe('good')
    expect(fitFor(3.2, true)?.band).toBe('mixed')
    expect(fitFor(2.4, true)?.band).toBe('weak')
  })

  it('writes the confidence row from counts', () => {
    expect(confidenceFor(14, 5).label).toBe('Medium confidence · 14 reviews, 5 on TastyPlates')
    expect(confidenceFor(25, 6).level).toBe('high')
    expect(confidenceFor(4, 1).level).toBe('low')
  })
})

describe('model output validation', () => {
  const facts = buildReadingFacts({
    restaurant: { uuid: R, title: 'Hanok House', cuisine: 'Korean' },
    entries: pool([native(5, ['korean']), native(4, ['korean']), native(4, ['korean'])]),
    taxonomy,
    viewerLeafIds: new Set([1]),
    groups: regionGroupsFromTaxonomy(taxonomy),
  })
  const reviews: ReviewText[] = [
    { id: 'rev-a', source: 'first_party', rating: 5, text: 'The galbi marinade tastes like home, sweet and smoky.', in_circles: true },
    { id: 'rev-b', source: 'external', rating: 4, text: 'Galbi was great but the wait was long on Friday.', in_circles: true },
    { id: 'rev-c', source: 'first_party', rating: 3, text: 'Service felt rushed and the banchan ran out.', in_circles: false },
  ]
  const { refs } = buildReadingPrompt(facts, selectPromptReviews(reviews))
  const refFor = (id: string) => [...refs.entries()].find(([, r]) => r.id === id)![0]

  const good = () => ({
    headline: 'A place that tastes like home for you',
    summary: 'Reviewers who grew up with Korean food love the galbi. The wait can be long.',
    agree: 'Everyone agrees the galbi is the reason to go.',
    group_takeaways: { 'east-asian': 'The marinade wins them over.', unknown: 'ignored' },
    themes: [
      { label: 'Galbi', detail: 'Sweet, smoky marinade.', quote: 'tastes like home, sweet and smoky', review_refs: [refFor('rev-a'), refFor('rev-b')] },
      { label: 'Service', detail: 'Can feel rushed.', quote: 'invented words nobody wrote', review_refs: [refFor('rev-c')] },
      { label: 'Ghost', detail: 'Cites nothing real.', quote: null, review_refs: ['r99'] },
    ],
  })

  it('counts and colours themes from the cited reviews', () => {
    const text = validateReadingText(good(), facts, refs)
    expect(text.themes).toHaveLength(2)
    expect(text.themes[0]).toMatchObject({ label: 'Galbi', review_count: 2, sentiment: 'positive', review_ids: ['rev-a'] })
    expect(text.themes[0]!.quote).toBe('tastes like home, sweet and smoky')
    expect(text.themes[1]).toMatchObject({ sentiment: 'mixed', quote: null })
    expect(Object.keys(text.group_takeaways)).toEqual(['east-asian'])
  })

  it('rejects text that states scores', () => {
    expect(() => validateReadingText({ ...good(), headline: 'Rated 4.5 by your palate' }, facts, refs)).toThrow()
    const text = validateReadingText({ ...good(), agree: 'Everyone gives it 5 stars' }, facts, refs)
    expect(text.agree).toBe('')
  })

  it('reads JSON wrapped in a code fence', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
})

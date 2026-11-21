import { describe, expect, it } from 'vitest'

import {
  bucketEntriesByCuisine,
  buildCuisineTaxonomy,
  buildPoolEntries,
  everyone,
  isPublicReviewStatus,
  leafIdsForSlugs,
  NATIVE_WEIGHT,
  type NativeReviewRow,
  resolveRestaurantCuisines,
  resolveReviewerIdentity,
  reviewerHasAnyLeaf,
  reviewerInAnyRegion,
  reviewerMatchesRestaurantCuisines,
  SCRAPED_WEIGHT,
  type ScrapedReviewRow,
  scorePool,
} from './reviewPool'

// Mirrors the production shape: regions have parent_id null; Vietnamese slug is capitalised.
const taxonomy = buildCuisineTaxonomy([
  { id: 2228, slug: 'eastern-asia', name: 'Eastern Asia', parent_id: null },
  { id: 2229, slug: 'southeast-asia', name: 'Southeast Asia', parent_id: null },
  { id: 2218, slug: 'western-europe', name: 'Western Europe', parent_id: null },
  { id: 13, slug: 'korean', name: 'Korean', parent_id: 2228 },
  { id: 14, slug: 'chinese', name: 'Chinese', parent_id: 2228 },
  { id: 2, slug: 'japanese', name: 'Japanese', parent_id: 2228 },
  { id: 2208, slug: 'Vietnamese', name: 'Vietnamese', parent_id: 2229 },
  { id: 46, slug: 'italian', name: 'Italian', parent_id: 2218 },
])

const R = 'b2a7b147-778e-4635-bd54-f3364c6fd717'

let seq = 0
function native(rating: number, extra: Partial<NativeReviewRow> = {}): NativeReviewRow {
  seq += 1
  return {
    id: `n${seq}`,
    restaurant_uuid: R,
    rating,
    status: 'approved',
    author_id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    palates: null,
    deleted_at: null,
    parent_review_id: null,
    ...extra,
  }
}

function scraped(rating: number, extra: Partial<ScrapedReviewRow> = {}): ScrapedReviewRow {
  seq += 1
  return {
    id: `s${seq}`,
    restaurant_uuid: R,
    rating,
    is_flagged: false,
    author_palates: null,
    source_author_id: `g${seq}`,
    source_author_name: null,
    ...extra,
  }
}

function pool(nativeRows: NativeReviewRow[], scrapedRows: ScrapedReviewRow[] = [], profiles = new Map<string, unknown>()) {
  return buildPoolEntries({ native: nativeRows, scraped: scrapedRows, profilePalatesByUserId: profiles, taxonomy })
}

describe('formula (spec §4)', () => {
  it('matches the worked example: 3 native avg 4.8 + 20 scraped avg 4.2 → 4.34, count 23', () => {
    const nativeRows = [native(5), native(5), native(4.4)] // avg 4.8
    const scrapedRows = [
      ...Array.from({ length: 4 }, () => scraped(5)),
      ...Array.from({ length: 16 }, () => scraped(4)),
    ] // (20 + 64) / 20 = 4.2
    const score = scorePool(pool(nativeRows, scrapedRows))

    expect(score.review_count).toBe(23)
    expect(score.total_weight).toBe(3 * NATIVE_WEIGHT + 20 * SCRAPED_WEIGHT)
    expect(score.display_avg).toBeCloseTo(112.8 / 26, 4)
    expect(Number(score.display_avg!.toFixed(2))).toBe(4.34)
    expect(score.native_count).toBe(3)
    expect(score.scraped_count).toBe(20)
    expect(score.native_avg).toBeCloseTo(4.8, 4)
    expect(score.scraped_avg).toBeCloseTo(4.2, 4)
  })

  it('smooths ranking toward 4.0 in weight units', () => {
    const score = scorePool(pool([native(5)]))
    expect(score.display_avg).toBe(5)
    // (5×2 + 4×5) / (2 + 5)
    expect(score.ranking_value).toBeCloseTo(30 / 7, 4)
  })

  it('returns nulls and zero counts for an empty pool', () => {
    const score = scorePool([])
    expect(score).toMatchObject({ display_avg: null, ranking_value: null, review_count: 0, total_weight: 0 })
  })
})

describe('inclusion rules (spec §3)', () => {
  it('counts approved and pending native reviews', () => {
    const entries = pool([native(4, { status: 'approved' }), native(2, { status: 'pending' })])
    expect(entries).toHaveLength(2)
  })

  it('excludes drafts, rejected, deleted and replies', () => {
    const entries = pool([
      native(4, { status: 'draft' }),
      native(4, { status: 'rejected' }),
      native(4, { deleted_at: '2026-11-01T00:00:00Z' }),
      native(4, { parent_review_id: 'parent' }),
    ])
    expect(entries).toHaveLength(0)
  })

  it('excludes flagged scraped reviews and out-of-range ratings', () => {
    const entries = pool([native(0), native(6)], [scraped(4, { is_flagged: true }), scraped(0)])
    expect(entries).toHaveLength(0)
  })

  it('does not apply a Google aggregate block (only real rows count)', () => {
    const score = scorePool(pool([native(5)]))
    expect(score.review_count).toBe(1)
  })
})

describe('reviewer identity', () => {
  it('reads native identity from user_profiles keyed by user_id, names or slugs', () => {
    const row = native(4, { author_id: 'ABCDEF00-0000-0000-0000-000000000001' })
    const profiles = new Map([['abcdef00-0000-0000-0000-000000000001', ['Chinese']]])
    const [entry] = pool([row], [], profiles)
    expect([...entry.identity.leafIds]).toEqual([14])
    expect([...entry.identity.regionIds]).toEqual([2228])
  })

  it('falls back to palates saved on the review when the profile has none', () => {
    const [entry] = pool([native(4, { palates: [{ slug: 'korean' }] })])
    expect([...entry.identity.leafIds]).toEqual([13])
  })

  it('matches slugs exactly after normalising case (Vietnamese)', () => {
    expect([...resolveReviewerIdentity(['vietnamese'], taxonomy).leafIds]).toEqual([2208])
    expect([...resolveReviewerIdentity('Vietnamese', taxonomy).leafIds]).toEqual([2208])
  })

  it('does not substring-match (korean-fusion is not korean)', () => {
    expect(resolveReviewerIdentity(['korean-fusion'], taxonomy).leafIds.size).toBe(0)
  })

  it('ignores region-level and unknown palate values', () => {
    const identity = resolveReviewerIdentity(['eastern-asia', 'caucasian'], taxonomy)
    expect(identity.leafIds.size).toBe(0)
  })
})

describe('scores differ only by reviewer filter (spec §5)', () => {
  const korean = native(5, { palates: ['korean'] })
  const chinese = native(4, { palates: ['chinese'] })
  const both = native(3, { palates: ['korean', 'chinese'] })
  const italian = native(2, { palates: ['italian'] })
  const untaggedScraped = scraped(1)
  const taggedScraped = scraped(5, { author_palates: ['japanese'] })
  const entries = pool([korean, chinese, both, italian], [untaggedScraped, taggedScraped])

  it('Overall includes everyone, including untagged scraped reviews', () => {
    expect(scorePool(entries, everyone).review_count).toBe(6)
  })

  it('untagged scraped reviews count toward Overall only', () => {
    const filters = [
      reviewerHasAnyLeaf([13, 14, 2, 46, 2208]),
      reviewerInAnyRegion([2228, 2229, 2218]),
    ]
    for (const filter of filters) {
      const counted = entries.filter(filter)
      expect(counted.some((e) => e.reviewerKey.endsWith(untaggedScraped.source_author_id!))).toBe(false)
    }
  })

  it('counts a reviewer with two matching palates once', () => {
    const shared = scorePool(entries, reviewerHasAnyLeaf(leafIdsForSlugs(['korean', 'chinese'], taxonomy)))
    expect(shared.review_count).toBe(3) // korean, chinese, both — not 4
  })

  it('Group uses the region of the reviewer palate', () => {
    const group = scorePool(entries, reviewerInAnyRegion([2228]))
    expect(group.review_count).toBe(4) // korean, chinese, both, japanese (scraped)
  })

  it('Authentic matches the restaurant cuisines exactly, by id or slug, dropping deleted ids', () => {
    const cuisines = resolveRestaurantCuisines(
      [{ id: 4, slug: 'east-asian' }, { id: 13, slug: 'korean' }],
      taxonomy,
    )
    expect([...cuisines.leafIds]).toEqual([13])
    expect(cuisines.regionIds.size).toBe(0) // id 4 no longer exists
    expect(scorePool(entries, reviewerMatchesRestaurantCuisines(cuisines)).review_count).toBe(2)
  })
})

describe('taste firewall (spec §9)', () => {
  it('taste data on the review, scraped tags or restaurant palates never changes a score', () => {
    const base = pool([native(4, { palates: ['korean'] })], [scraped(3, { author_palates: ['chinese'] })])

    // Taste values are not cuisine slugs, so they resolve to nothing even if they reach identity.
    const withTaste = pool(
      [native(4, { palates: ['korean', 'spicy', 'korean-spice'] })],
      [scraped(3, { author_palates: ['chinese', 'umami'] })],
    )
    const tasteCuisines = resolveRestaurantCuisines([{ slug: 'korean' }], taxonomy)
    const leakyCuisines = resolveRestaurantCuisines([{ slug: 'korean' }, { slug: 'korean-spice' }], taxonomy)

    for (const filter of [
      everyone,
      reviewerHasAnyLeaf([13, 14]),
      reviewerInAnyRegion([2228]),
      reviewerMatchesRestaurantCuisines(tasteCuisines),
    ]) {
      expect(scorePool(withTaste, filter)).toEqual(scorePool(base, filter))
    }
    expect(scorePool(base, reviewerMatchesRestaurantCuisines(leakyCuisines))).toEqual(
      scorePool(base, reviewerMatchesRestaurantCuisines(tasteCuisines)),
    )
  })
})

describe('palate rows (unweighted, per source)', () => {
  it('counts a review once per leaf and once per shared region', () => {
    const entries = pool([native(5, { palates: ['korean', 'chinese'] }), native(3, { palates: ['korean'] })])
    const buckets = bucketEntriesByCuisine(entries)
    expect(buckets.get(13)).toMatchObject({ sum: 8, count: 2 }) // korean
    expect(buckets.get(14)).toMatchObject({ sum: 5, count: 1 }) // chinese
    expect(buckets.get(2228)).toMatchObject({ sum: 8, count: 2 }) // eastern-asia once per review
    expect(buckets.get(2228)!.reviewers.size).toBe(2)
  })

  it('stores raw sums, not weighted ones', () => {
    const buckets = bucketEntriesByCuisine(pool([native(4, { palates: ['italian'] })]))
    expect(buckets.get(46)!.sum).toBe(4) // not 4 × NATIVE_WEIGHT
  })

  it('skips reviewers without a palate', () => {
    expect(bucketEntriesByCuisine(pool([], [scraped(5)])).size).toBe(0)
  })
})

describe('request slugs and public status', () => {
  it('expands a region slug to its cuisines only when asked', () => {
    expect(leafIdsForSlugs(['eastern-asia'], taxonomy).size).toBe(0)
    expect([...leafIdsForSlugs(['eastern-asia'], taxonomy, { expandRegions: true })].sort((a, b) => a - b)).toEqual([2, 13, 14])
  })

  it('treats approved, pending and missing status as public; draft and rejected as private', () => {
    expect(isPublicReviewStatus('approved')).toBe(true)
    expect(isPublicReviewStatus('pending')).toBe(true)
    expect(isPublicReviewStatus(null)).toBe(true)
    expect(isPublicReviewStatus('draft')).toBe(false)
    expect(isPublicReviewStatus('rejected')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import {
  bucketStarts,
  computeRestaurantPerformance,
  type PerformanceInput,
  rangeStart,
} from './restaurantPerformance'
import {
  buildCuisineTaxonomy,
  buildPoolEntries,
  type NativeReviewRow,
  resolveRestaurantCuisines,
  type ScrapedReviewRow,
} from './reviewPool'

const taxonomy = buildCuisineTaxonomy([
  { id: 2228, slug: 'eastern-asia', name: 'Eastern Asia', parent_id: null },
  { id: 2214, slug: 'north-america', name: 'North America', parent_id: null },
  { id: 13, slug: 'korean', name: 'Korean', parent_id: 2228 },
  { id: 41, slug: 'canadian', name: 'Canadian', parent_id: 2214 },
])

const NOW = new Date('2026-11-22T12:00:00Z')
const R = 'b2a7b147-778e-4635-bd54-f3364c6fd717'
const PEER = 'aaaaaaaa-0000-0000-0000-000000000001'

let seq = 0
const native = (rating: number, created_at: string, palates: unknown = ['korean'], restaurant_uuid = R): NativeReviewRow => {
  seq += 1
  return { id: `n${seq}`, restaurant_uuid, rating, status: 'approved', author_id: null, palates, created_at }
}
const scraped = (rating: number, reviewed_at: string, author_palates: unknown = null): ScrapedReviewRow => {
  seq += 1
  return { id: `s${seq}`, restaurant_uuid: R, rating, is_flagged: false, author_palates, source_author_id: `g${seq}`, reviewed_at }
}

function input(overrides: Partial<PerformanceInput> & { nativeRows?: NativeReviewRow[]; scrapedRows?: ScrapedReviewRow[] }): PerformanceInput {
  const entries = buildPoolEntries({
    native: overrides.nativeRows ?? [],
    scraped: overrides.scrapedRows ?? [],
    profilePalatesByUserId: new Map(),
    taxonomy,
  })
  return {
    now: NOW,
    range: '90d',
    restaurantUuid: R,
    hasGooglePlace: true,
    entries: entries.filter((e) => e.restaurantUuid === R),
    restaurantCuisines: resolveRestaurantCuisines([{ id: 13 }], taxonomy),
    taxonomy,
    peers: null,
    nativeExtras: [],
    scrapedTaste: [],
    engagement: { checkins: [], listAdds: [], saves: [], likes: [], replies: [] },
    storedSummary: null,
    ...overrides,
  }
}

describe('time windows', () => {
  it('computes range starts and caps buckets', () => {
    expect(rangeStart('30d', NOW)?.toISOString()).toBe('2026-10-23T12:00:00.000Z')
    expect(rangeStart('all', NOW)).toBeNull()
    const weeks = bucketStarts(new Date('2026-10-23T12:00:00Z'), NOW, 'week')
    expect(weeks[0].getUTCDay()).toBe(1) // Monday
    expect(bucketStarts(new Date('2019-01-01'), NOW, 'month')).toHaveLength(36)
  })
})

describe('KPIs', () => {
  const rows = [native(2, '2026-05-01T00:00:00Z'), native(4, '2026-11-01T00:00:00Z'), native(5, '2026-11-10T00:00:00Z')]

  it('compares the score now with the score at the start of the range', () => {
    const perf = computeRestaurantPerformance(input({ nativeRows: rows }))
    expect(perf.kpis.overall.previous_avg).toBe(2) // only the May review existed 90 days ago
    expect(perf.kpis.overall.avg).toBeCloseTo(3.67, 2)
    expect(perf.kpis.overall.delta).toBeCloseTo(1.67, 2)
    expect(perf.kpis.new_reviews).toMatchObject({ total: 2, native: 2, scraped: 0 })
  })

  it('has no previous values for "all"', () => {
    const perf = computeRestaurantPerformance(input({ nativeRows: rows, range: 'all' }))
    expect(perf.kpis.overall.previous_avg).toBeNull()
    expect(perf.kpis.new_reviews.previous_total).toBeNull()
  })

  it('counts engagement only inside the range', () => {
    const perf = computeRestaurantPerformance(
      input({
        engagement: {
          checkins: ['2026-11-01T00:00:00Z', '2025-01-01T00:00:00Z'],
          listAdds: ['2026-10-01T00:00:00Z'],
          saves: [],
          likes: ['2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z'],
          replies: [null],
        },
      }),
    )
    expect(perf.kpis.engagement).toEqual({ checkins: 1, list_adds: 1, saves: 0, likes: 2, replies: 0, total: 4 })
  })

  it('ranks against peers now and at the start of the range', () => {
    const peerRows = [native(4.5, '2026-01-01T00:00:00Z', ['korean'], PEER), native(4.5, '2026-01-02T00:00:00Z', ['korean'], PEER)]
    const all = buildPoolEntries({ native: [...rows, ...peerRows], scraped: [], profilePalatesByUserId: new Map(), taxonomy })
    const byUuid = new Map([
      [R, all.filter((e) => e.restaurantUuid === R)],
      [PEER, all.filter((e) => e.restaurantUuid === PEER)],
    ])
    const perf = computeRestaurantPerformance(
      input({ nativeRows: rows, peers: { cuisineName: 'Korean', scope: 'Calgary', entriesByUuid: byUuid } }),
    )
    expect(perf.kpis.rank).toMatchObject({ of: 2, cuisine_name: 'Korean', scope: 'Calgary' })
    expect(perf.kpis.rank!.previous_position).toBe(2) // only the 2★ review 90 days ago
  })
})

describe('charts', () => {
  it('builds a cumulative trend with per-bucket counts by source', () => {
    const perf = computeRestaurantPerformance(
      input({
        range: '30d',
        nativeRows: [native(4, '2026-11-03T10:00:00Z')],
        scrapedRows: [scraped(2, '2026-11-18T10:00:00Z')],
      }),
    )
    expect(perf.window.granularity).toBe('week')
    const totals = perf.trend.reduce(
      (acc, b) => ({ n: acc.n + b.native_reviews, s: acc.s + b.scraped_reviews }),
      { n: 0, s: 0 },
    )
    expect(totals).toEqual({ n: 1, s: 1 })
    expect(perf.trend.at(-1)!.overall_avg).toBeCloseTo((4 * 2 + 2) / 3, 2)
  })

  it('bins the distribution by half star and source', () => {
    const perf = computeRestaurantPerformance(
      input({ nativeRows: [native(3.5, '2026-11-01T00:00:00Z')], scrapedRows: [scraped(5, '2026-11-01T00:00:00Z')] }),
    )
    expect(perf.distribution.find((d) => d.rating === 3.5)).toMatchObject({ native: 1, scraped: 0 })
    expect(perf.distribution.find((d) => d.rating === 5)).toMatchObject({ native: 0, scraped: 1 })
  })

  it('reports palate fit per reviewer region against Overall', () => {
    const perf = computeRestaurantPerformance(
      input({ nativeRows: [native(5, '2026-11-01T00:00:00Z', ['korean']), native(3, '2026-11-01T00:00:00Z', ['canadian'])] }),
    )
    const eastern = perf.palate_fit.find((p) => p.region_name === 'Eastern Asia')!
    expect(eastern).toMatchObject({ avg: 5, review_count: 1, delta_vs_overall: 1 })
  })
})

describe('signals and health', () => {
  it('counts recognitions, hashtags and taste tags (taste stays taste)', () => {
    const perf = computeRestaurantPerformance(
      input({
        nativeExtras: [
          { created_at: '2026-11-01T00:00:00Z', recognitions: ['Must Revisit', 'Value for Money'], hashtags: '{brunch,Patio}' },
          { created_at: '2026-11-02T00:00:00Z', recognitions: ['Must Revisit'], hashtags: null },
        ],
        scrapedTaste: [{ at: '2026-11-03T00:00:00Z', tags: ['Spicy', 'umami'] }],
      }),
    )
    expect(perf.signals.recognitions[0]).toEqual({ label: 'Must Revisit', count: 2 })
    expect(perf.signals.hashtags.map((h) => h.label)).toEqual(['#brunch', '#patio'])
    expect(perf.signals.taste_tags.map((t) => t.label)).toEqual(['spicy', 'umami'])
  })

  it('flags stale summaries, missing cuisine, untagged scraped reviews and locked Shared', () => {
    const perf = computeRestaurantPerformance(
      input({
        nativeRows: [native(4, '2026-11-01T00:00:00Z')],
        scrapedRows: [scraped(3, '2026-11-02T00:00:00Z')],
        storedSummary: { overall_avg: 4, overall_count: 1, updated_at: '2026-10-01T00:00:00Z' },
      }),
    )
    const keys = Object.fromEntries(perf.health.map((h) => [h.key, h]))
    expect(keys.summary_stale).toMatchObject({ status: 'warn', action: 'rebuild_ratings' })
    expect(keys.untagged_scraped).toMatchObject({ status: 'warn', action: 'tag_author_palates' })
    expect(keys.shared_locked.message).toContain('Korean (1/3)')

    const noCuisine = computeRestaurantPerformance(
      input({ restaurantCuisines: { leafIds: new Set(), regionIds: new Set() } }),
    )
    expect(noCuisine.health.find((h) => h.key === 'no_cuisine')).toMatchObject({ action: 'set_cuisine' })
    expect(noCuisine.health.find((h) => h.key === 'summary_stale')?.status).toBe('ok')
  })
})

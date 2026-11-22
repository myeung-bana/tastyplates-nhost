/**
 * Restaurant performance analytics (admin) — pure computation, no I/O.
 *
 * Every score here comes from the Rating Model v3 review pool via `scorePool`, so the dashboard
 * always matches what users see. Loading lives in `restaurantPerformanceLoader.ts`.
 */
import {
  type CuisineTaxonomy,
  hasIdentity,
  type PoolEntry,
  reviewerInAnyRegion,
  reviewerMatchesRestaurantCuisines,
  everyone,
  scorePool,
} from './reviewPool'

export type PerformanceRange = '30d' | '90d' | '1y' | 'all'
export const PERFORMANCE_RANGES: readonly PerformanceRange[] = ['30d', '90d', '1y', 'all']
export const SHARED_MIN_REVIEWS = 3
const MAX_TREND_BUCKETS = 36

type Granularity = 'week' | 'month'

export type ScoreKpi = {
  avg: number | null
  review_count: number
  ranking_value: number | null
  /** Score as it stood at the start of the range (null for "all"). */
  previous_avg: number | null
  delta: number | null
}

export type RestaurantPerformance = {
  restaurant_uuid: string
  range: PerformanceRange
  generated_at: string
  window: { start: string | null; end: string; granularity: Granularity }
  kpis: {
    overall: ScoreKpi
    authentic: ScoreKpi
    new_reviews: { total: number; native: number; scraped: number; previous_total: number | null }
    rank: {
      position: number | null
      of: number
      previous_position: number | null
      cuisine_name: string
      scope: string
    } | null
    engagement: {
      checkins: number
      list_adds: number
      saves: number
      likes: number
      replies: number
      total: number
    }
  }
  trend: Array<{
    bucket_start: string
    overall_avg: number | null
    authentic_avg: number | null
    native_reviews: number
    scraped_reviews: number
  }>
  distribution: Array<{ rating: number; native: number; scraped: number }>
  palate_fit: Array<{
    region_id: number
    region_name: string
    avg: number | null
    review_count: number
    delta_vs_overall: number | null
  }>
  signals: {
    recognitions: Array<{ label: string; count: number }>
    hashtags: Array<{ label: string; count: number }>
    taste_tags: Array<{ label: string; count: number }>
  }
  health: Array<{
    key: string
    status: 'ok' | 'warn'
    message: string
    action?: 'rebuild_ratings' | 'trigger_scrape' | 'tag_author_palates' | 'set_cuisine'
  }>
}

export type PerformanceInput = {
  now: Date
  range: PerformanceRange
  restaurantUuid: string
  hasGooglePlace: boolean
  /** This restaurant's pool entries. */
  entries: readonly PoolEntry[]
  restaurantCuisines: { leafIds: ReadonlySet<number>; regionIds: ReadonlySet<number> }
  taxonomy: CuisineTaxonomy
  /** Same-cuisine published restaurants (including this one) for ranking. */
  peers: { cuisineName: string; scope: string; entriesByUuid: Map<string, readonly PoolEntry[]> } | null
  /** Public top-level native reviews: recognitions and hashtags. */
  nativeExtras: Array<{ created_at: string | null; recognitions: unknown; hashtags: unknown }>
  /** Unflagged scraped reviews: taste tags (`palates` column — taste, never identity). */
  scrapedTaste: Array<{ at: string | null; tags: unknown }>
  engagement: {
    checkins: Array<string | null>
    listAdds: Array<string | null>
    saves: Array<string | null>
    likes: Array<string | null>
    replies: Array<string | null>
  }
  storedSummary: { overall_avg: number | null; overall_count: number; updated_at: string | null } | null
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000

export function rangeStart(range: PerformanceRange, now: Date): Date | null {
  if (range === '30d') return new Date(now.getTime() - 30 * DAY)
  if (range === '90d') return new Date(now.getTime() - 90 * DAY)
  if (range === '1y') return new Date(now.getTime() - 365 * DAY)
  return null
}

export function granularityFor(range: PerformanceRange): Granularity {
  return range === '30d' || range === '90d' ? 'week' : 'month'
}

function startOfBucket(date: Date, granularity: Granularity): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  if (granularity === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const weekday = (d.getUTCDay() + 6) % 7 // Monday = 0
  return new Date(d.getTime() - weekday * DAY)
}

function nextBucket(date: Date, granularity: Granularity): Date {
  if (granularity === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return new Date(date.getTime() + 7 * DAY)
}

/** Bucket starts covering [start, now]; "all" starts at the earliest dated review. Capped at 36. */
export function bucketStarts(start: Date, now: Date, granularity: Granularity): Date[] {
  const out: Date[] = []
  for (let b = startOfBucket(start, granularity); b <= now; b = nextBucket(b, granularity)) out.push(b)
  return out.slice(-MAX_TREND_BUCKETS)
}

const ts = (value: string | null | undefined): number | null => {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/** Entries written before `cutoff`. Undated entries are treated as old (always included). */
function asOf(entries: readonly PoolEntry[], cutoff: number): PoolEntry[] {
  return entries.filter((e) => {
    const t = ts(e.reviewedAt)
    return t == null || t < cutoff
  })
}

function inWindow(at: string | null | undefined, start: number | null, end: number): boolean {
  const t = ts(at)
  if (t == null) return start == null
  return (start == null || t >= start) && t <= end
}

const round2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100)

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function labelsOf(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean)
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return []
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return labelsOf(JSON.parse(s.startsWith('{') ? `[${s.slice(1, -1)}]` : s))
      } catch {
        // Postgres array literal: {a,b}
        return s.replace(/^[{[]|[}\]]$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean)
      }
    }
    return s.split(/[,|]/).map((x) => x.trim()).filter(Boolean)
  }
  return []
}

function topCounts(lists: string[][], limit = 8, normalize?: (s: string) => string) {
  const counts = new Map<string, number>()
  for (const list of lists) {
    for (const raw of new Set(list)) {
      const label = normalize ? normalize(raw) : raw
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function rankOf(
  entriesByUuid: Map<string, readonly PoolEntry[]>,
  targetUuid: string,
  cutoff: number | null,
): { position: number | null; of: number } {
  const scored = [...entriesByUuid.entries()]
    .map(([uuid, list]) => ({ uuid, score: scorePool(cutoff == null ? list : asOf(list, cutoff), everyone) }))
    .filter((x) => x.score.review_count > 0)
    .sort((a, b) => (b.score.ranking_value ?? 0) - (a.score.ranking_value ?? 0) || b.score.review_count - a.score.review_count)
  const index = scored.findIndex((x) => x.uuid === targetUuid)
  return { position: index >= 0 ? index + 1 : null, of: scored.length }
}

export function computeRestaurantPerformance(input: PerformanceInput): RestaurantPerformance {
  const nowMs = input.now.getTime()
  const start = rangeStart(input.range, input.now)
  const startMs = start?.getTime() ?? null
  const granularity = granularityFor(input.range)
  const entries = input.entries
  const hasCuisines = input.restaurantCuisines.leafIds.size > 0 || input.restaurantCuisines.regionIds.size > 0
  const authenticFilter = reviewerMatchesRestaurantCuisines(input.restaurantCuisines)

  // KPIs: score now vs as it stood at the start of the range.
  const overallNow = scorePool(entries, everyone)
  const authenticNow = hasCuisines ? scorePool(entries, authenticFilter) : scorePool([])
  const before = startMs == null ? null : asOf(entries, startMs)
  const overallBefore = before ? scorePool(before, everyone) : null
  const authenticBefore = before && hasCuisines ? scorePool(before, authenticFilter) : null
  const kpi = (now: ReturnType<typeof scorePool>, prev: ReturnType<typeof scorePool> | null): ScoreKpi => ({
    avg: round2(now.display_avg),
    review_count: now.review_count,
    ranking_value: round2(now.ranking_value),
    previous_avg: prev ? round2(prev.display_avg) : null,
    delta:
      prev?.display_avg != null && now.display_avg != null
        ? round2(now.display_avg - prev.display_avg)
        : null,
  })

  const inRange = entries.filter((e) => inWindow(e.reviewedAt, startMs, nowMs))
  const previousWindow =
    startMs == null
      ? null
      : entries.filter((e) => inWindow(e.reviewedAt, startMs - (nowMs - startMs), startMs - 1))

  // Rank among same-cuisine peers, by Overall ranking value.
  let rank: RestaurantPerformance['kpis']['rank'] = null
  if (input.peers) {
    const nowRank = rankOf(input.peers.entriesByUuid, input.restaurantUuid, null)
    const prevRank = startMs == null ? null : rankOf(input.peers.entriesByUuid, input.restaurantUuid, startMs)
    rank = {
      position: nowRank.position,
      of: nowRank.of,
      previous_position: prevRank?.position ?? null,
      cuisine_name: input.peers.cuisineName,
      scope: input.peers.scope,
    }
  }

  const count = (list: Array<string | null>) => list.filter((at) => inWindow(at, startMs, nowMs)).length
  const engagement = {
    checkins: count(input.engagement.checkins),
    list_adds: count(input.engagement.listAdds),
    saves: count(input.engagement.saves),
    likes: count(input.engagement.likes),
    replies: count(input.engagement.replies),
    total: 0,
  }
  engagement.total =
    engagement.checkins + engagement.list_adds + engagement.saves + engagement.likes + engagement.replies

  // Trend: cumulative score at each bucket end + new reviews within the bucket.
  const datedTimes = entries.map((e) => ts(e.reviewedAt)).filter((t): t is number => t != null)
  const trendStart = start ?? (datedTimes.length ? new Date(Math.min(...datedTimes)) : null)
  const trend: RestaurantPerformance['trend'] = []
  if (trendStart) {
    const starts = bucketStarts(trendStart, input.now, granularity)
    starts.forEach((bucket, i) => {
      const bStart = bucket.getTime()
      const bEnd = i + 1 < starts.length ? starts[i + 1].getTime() : nowMs + 1
      const upTo = asOf(entries, bEnd)
      const within = entries.filter((e) => {
        const t = ts(e.reviewedAt)
        return t != null && t >= bStart && t < bEnd
      })
      trend.push({
        bucket_start: bucket.toISOString(),
        overall_avg: round2(scorePool(upTo, everyone).display_avg),
        authentic_avg: hasCuisines ? round2(scorePool(upTo, authenticFilter).display_avg) : null,
        native_reviews: within.filter((e) => e.source === 'first_party').length,
        scraped_reviews: within.filter((e) => e.source === 'external').length,
      })
    })
  }

  // Distribution of reviews written in range, by half star.
  const distribution = Array.from({ length: 10 }, (_, i) => ({ rating: (i + 1) / 2, native: 0, scraped: 0 }))
  for (const e of inRange) {
    const slot = distribution[Math.min(9, Math.max(0, Math.round(e.rating * 2) - 1))]
    if (e.source === 'first_party') slot.native += 1
    else slot.scraped += 1
  }

  // Palate fit: each reviewer region's score vs Overall (all time, same as the Group score).
  const regionIds = new Set<number>()
  for (const e of entries) e.identity.regionIds.forEach((id) => regionIds.add(id))
  const palate_fit = [...regionIds]
    .map((regionId) => {
      const score = scorePool(entries, reviewerInAnyRegion([regionId]))
      return {
        region_id: regionId,
        region_name: input.taxonomy.byId.get(regionId)?.name ?? String(regionId),
        avg: round2(score.display_avg),
        review_count: score.review_count,
        delta_vs_overall:
          score.display_avg != null && overallNow.display_avg != null
            ? round2(score.display_avg - overallNow.display_avg)
            : null,
      }
    })
    .sort((a, b) => b.review_count - a.review_count || a.region_name.localeCompare(b.region_name))

  // Signals in range. Taste tags are taste, never identity.
  const extrasInRange = input.nativeExtras.filter((r) => inWindow(r.created_at, startMs, nowMs))
  const signals = {
    recognitions: topCounts(extrasInRange.map((r) => labelsOf(r.recognitions))),
    hashtags: topCounts(
      extrasInRange.map((r) => labelsOf(r.hashtags)),
      8,
      (s) => `#${s.replace(/^#/, '').toLowerCase()}`,
    ),
    taste_tags: topCounts(
      input.scrapedTaste.filter((r) => inWindow(r.at, startMs, nowMs)).map((r) => labelsOf(r.tags)),
      8,
      (s) => s.toLowerCase(),
    ),
  }

  // Data health.
  const health: RestaurantPerformance['health'] = []
  const latestReview = datedTimes.length ? Math.max(...datedTimes) : null
  const summaryAt = ts(input.storedSummary?.updated_at)
  const storedMatches =
    input.storedSummary == null
      ? overallNow.review_count === 0
      : input.storedSummary.overall_count === overallNow.review_count &&
        round2(input.storedSummary.overall_avg) === round2(overallNow.display_avg)
  if (!storedMatches || (latestReview != null && summaryAt != null && summaryAt < latestReview)) {
    health.push({
      key: 'summary_stale',
      status: 'warn',
      message: 'Stored scores are out of date: users may see old numbers until ratings are rebuilt.',
      action: 'rebuild_ratings',
    })
  } else {
    health.push({ key: 'summary_stale', status: 'ok', message: 'Stored scores match the live review pool.' })
  }
  if (!hasCuisines) {
    health.push({
      key: 'no_cuisine',
      status: 'warn',
      message: 'No cuisine set, so there is no Authentic score.',
      action: 'set_cuisine',
    })
  }
  const scraped = entries.filter((e) => e.source === 'external')
  const untagged = scraped.filter((e) => !hasIdentity(e.identity)).length
  if (untagged > 0) {
    health.push({
      key: 'untagged_scraped',
      status: 'warn',
      message: `${untagged} scraped review${untagged === 1 ? '' : 's'} without author palates count toward Overall only.`,
      action: 'tag_author_palates',
    })
  }
  if (scraped.length === 0 && input.hasGooglePlace) {
    health.push({
      key: 'no_scraped',
      status: 'warn',
      message: 'No scraped reviews yet for a Google-linked restaurant.',
      action: 'trigger_scrape',
    })
  }
  const locked = [...input.restaurantCuisines.leafIds]
    .map((leafId) => ({
      name: input.taxonomy.byId.get(leafId)?.name ?? String(leafId),
      count: entries.filter((e) => e.identity.leafIds.has(leafId)).length,
    }))
    .filter((x) => x.count < SHARED_MIN_REVIEWS)
  if (locked.length > 0) {
    health.push({
      key: 'shared_locked',
      status: 'warn',
      message: `Shared score locked for ${locked.map((x) => `${x.name} (${x.count}/${SHARED_MIN_REVIEWS})`).join(', ')}.`,
    })
  }
  const withPalate = entries.filter((e) => hasIdentity(e.identity)).length
  health.push({
    key: 'coverage',
    status: entries.length === 0 || withPalate === entries.length ? 'ok' : 'warn',
    message: `${withPalate} of ${entries.length} reviews have a reviewer palate.`,
  })

  return {
    restaurant_uuid: input.restaurantUuid,
    range: input.range,
    generated_at: input.now.toISOString(),
    window: { start: start?.toISOString() ?? null, end: input.now.toISOString(), granularity },
    kpis: {
      overall: kpi(overallNow, overallBefore),
      authentic: kpi(authenticNow, authenticBefore),
      new_reviews: {
        total: inRange.length,
        native: inRange.filter((e) => e.source === 'first_party').length,
        scraped: inRange.filter((e) => e.source === 'external').length,
        previous_total: previousWindow ? previousWindow.length : null,
      },
      rank,
      engagement,
    },
    trend,
    distribution,
    palate_fit,
    signals,
    health,
  }
}

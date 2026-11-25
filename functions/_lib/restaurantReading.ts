/**
 * Personalised reading — pure logic, no I/O.
 *
 * Split of responsibilities:
 *   - Every number (scores, counts, locks, fit band, confidence, theme counts and sentiment) is
 *     computed here from the Rating Model v3 review pool.
 *   - The language model only writes text: headline, summary, group takeaways, the "agree" line and
 *     theme wording. It cites reviews by id; this module counts them and checks every quote against
 *     the real review text.
 *   - Palates are food backgrounds ("reviewers who grew up with Korean food"), never nationality.
 *
 * I/O (loading, saving, the OpenRouter call) lives in `restaurantReadingStore.ts`.
 */
import {
  type CuisineTaxonomy,
  type PoolEntry,
  normalizeCuisineSlug,
  reviewerHasAnyLeaf,
  scorePool,
} from './reviewPool'

/** Reviews from the viewer's palates needed before a reading can be written (same as Shared). */
export const READING_MIN_REVIEWS = 3
export const READING_MAX_THEMES = 3
export const QUOTE_MAX_WORDS = 12
/** Reviews sent to the model. Circle reviewers first, then everyone else. */
export const PROMPT_MAX_REVIEWS = 60
export const PROMPT_MAX_REVIEW_CHARS = 420

const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

// ---------------------------------------------------------------------------
// Facts (numbers)
// ---------------------------------------------------------------------------

export type ReadingGroupInput = { slug: string; name: string; member_cuisine_ids: readonly number[] }

export type ReadingMember = { slug: string; name: string; avg: number | null; review_count: number }

export type ReadingGroup = {
  slug: string
  name: string
  avg: number | null
  review_count: number
  unlocked: boolean
  /** "You picked Korean, which is part of East Asian." Null for other groups. */
  why: string | null
  members: ReadingMember[]
}

export type FitBand = 'strong' | 'good' | 'mixed' | 'weak'

export type ReadingFacts = {
  restaurant: { uuid: string; title: string; cuisine: string | null }
  /** All reviews in the pool at this restaurant. */
  based_on: number
  overall: { avg: number | null; review_count: number }
  /** "Your circles": reviewers who share any of the viewer's palates. */
  circles: { avg: number | null; review_count: number; native_count: number; unlocked: boolean }
  min_reviews: number
  fit: { band: FitBand; label: string } | null
  confidence: { level: 'high' | 'medium' | 'low'; label: string }
  your_groups: ReadingGroup[]
  other_groups: ReadingGroup[]
  /** Viewer's palate names, for copy. */
  palate_names: string[]
}

export function fitFor(avg: number | null, unlocked: boolean): ReadingFacts['fit'] {
  if (!unlocked || avg == null) return null
  if (avg >= 4.3) return { band: 'strong', label: 'Strong match' }
  if (avg >= 3.8) return { band: 'good', label: 'Good match' }
  if (avg >= 3.0) return { band: 'mixed', label: 'Mixed match' }
  return { band: 'weak', label: 'Weak match' }
}

export function confidenceFor(reviewCount: number, nativeCount: number): ReadingFacts['confidence'] {
  const level = reviewCount >= 20 && nativeCount >= 5 ? 'high' : reviewCount >= 8 ? 'medium' : 'low'
  const word = level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low'
  const reviews = `${reviewCount} review${reviewCount === 1 ? '' : 's'}`
  return { level, label: `${word} confidence · ${reviews}, ${nativeCount} on TastyPlates` }
}

export function buildReadingFacts(input: {
  restaurant: { uuid: string; title: string; cuisine: string | null }
  entries: readonly PoolEntry[]
  taxonomy: CuisineTaxonomy
  viewerLeafIds: ReadonlySet<number>
  groups: readonly ReadingGroupInput[]
}): ReadingFacts {
  const { entries, taxonomy, viewerLeafIds, groups } = input
  const viewerLeaves = [...viewerLeafIds]
  const overall = scorePool(entries)
  const circles = scorePool(entries, reviewerHasAnyLeaf(viewerLeaves))
  const circlesUnlocked = circles.review_count >= READING_MIN_REVIEWS

  const yourGroups: ReadingGroup[] = []
  const otherGroups: ReadingGroup[] = []
  for (const group of groups) {
    const pooled = scorePool(entries, reviewerHasAnyLeaf(group.member_cuisine_ids))
    const members: ReadingMember[] = group.member_cuisine_ids
      .map((id) => {
        const row = taxonomy.byId.get(id)
        const score = scorePool(entries, reviewerHasAnyLeaf([id]))
        return {
          slug: row ? normalizeCuisineSlug(row.slug) : String(id),
          name: row?.name ?? String(id),
          avg: round2(score.display_avg),
          review_count: score.review_count,
        }
      })
      .sort((a, b) => b.review_count - a.review_count || a.name.localeCompare(b.name))

    const picked = group.member_cuisine_ids
      .filter((id) => viewerLeafIds.has(id))
      .map((id) => taxonomy.byId.get(id)?.name)
      .filter((n): n is string => Boolean(n))

    const row: ReadingGroup = {
      slug: group.slug,
      name: group.name,
      avg: round2(pooled.display_avg),
      review_count: pooled.review_count,
      unlocked: pooled.review_count >= READING_MIN_REVIEWS,
      why: picked.length ? `You picked ${joinNames(picked)}, which ${picked.length > 1 ? 'are' : 'is'} part of ${group.name}.` : null,
      members,
    }
    if (picked.length) yourGroups.push(row)
    else otherGroups.push(row)
  }
  const byReviews = (a: ReadingGroup, b: ReadingGroup) => b.review_count - a.review_count || a.name.localeCompare(b.name)
  yourGroups.sort(byReviews)
  otherGroups.sort(byReviews)

  return {
    restaurant: input.restaurant,
    based_on: overall.review_count,
    overall: { avg: round2(overall.display_avg), review_count: overall.review_count },
    circles: {
      avg: round2(circles.display_avg),
      review_count: circles.review_count,
      native_count: circles.native_count,
      unlocked: circlesUnlocked,
    },
    min_reviews: READING_MIN_REVIEWS,
    fit: fitFor(circles.display_avg, circlesUnlocked),
    confidence: confidenceFor(circles.review_count, circles.native_count),
    your_groups: yourGroups,
    other_groups: otherGroups,
    palate_names: viewerLeaves.map((id) => taxonomy.byId.get(id)?.name).filter((n): n is string => Boolean(n)),
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Taxonomy regions as groups, for when no reviewer groups are configured yet: each region with
 * its leaf cuisines ("East Asian" = Korean, Japanese, Chinese…).
 */
export function regionGroupsFromTaxonomy(taxonomy: CuisineTaxonomy): ReadingGroupInput[] {
  const groups: ReadingGroupInput[] = []
  for (const region of taxonomy.byId.values()) {
    if (region.parent_id != null) continue
    const members = [...taxonomy.byId.values()].filter((c) => c.parent_id === region.id).map((c) => c.id)
    if (members.length > 0) {
      groups.push({ slug: normalizeCuisineSlug(region.slug), name: region.name, member_cuisine_ids: members })
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export type ReviewText = {
  id: string
  source: 'first_party' | 'external'
  rating: number
  text: string
  /** Reviewer shares one of the viewer's palates. */
  in_circles: boolean
}

/** Pick reviews for the prompt: circle reviewers first, longer texts first, capped. */
export function selectPromptReviews(reviews: readonly ReviewText[]): ReviewText[] {
  return [...reviews]
    .filter((r) => r.text.trim().length >= 20)
    .sort((a, b) => Number(b.in_circles) - Number(a.in_circles) || b.text.length - a.text.length)
    .slice(0, PROMPT_MAX_REVIEWS)
}

export function buildReadingPrompt(facts: ReadingFacts, reviews: readonly ReviewText[]): { system: string; user: string; refs: Map<string, ReviewText> } {
  const refs = new Map<string, ReviewText>()
  const lines = reviews.map((review, i) => {
    const ref = `r${i + 1}`
    refs.set(ref, review)
    const text = review.text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX_REVIEW_CHARS)
    return `${ref} | ${review.in_circles ? 'same palate' : 'other palate'} | ${review.rating}/5 | ${text}`
  })

  const system = [
    'You write short, warm, plain-English restaurant readings for the TastyPlates app.',
    'Rules:',
    '- Write text only. Never write numbers, scores, ratings, stars, counts or percentages; the app shows those.',
    '- Describe palates as food backgrounds: "reviewers who grew up with Korean food". Never name nationalities or ethnicities ("Koreans", "Japanese people").',
    '- Only say what the reviews support. Do not invent dishes, prices or facts.',
    '- Quotes must be copied exactly from one review, at most 12 words, or null.',
    '- Reply with JSON only, no markdown.',
  ].join('\n')

  const groups = facts.your_groups.map((g) => `${g.slug} (${g.name}): ${g.unlocked ? 'enough reviews' : 'early signal, few reviews'}`)
  const fit = facts.fit?.label ?? 'not enough reviews to call'

  const user = [
    `Restaurant: ${facts.restaurant.title}${facts.restaurant.cuisine ? ` (${facts.restaurant.cuisine})` : ''}`,
    `Reader grew up with: ${facts.palate_names.join(', ') || 'unknown'} food`,
    `How reviewers who share the reader's palate rate it compared with everyone: ${describeGap(facts)}`,
    `Fit for the reader: ${fit}`,
    `Reader's groups: ${groups.join('; ') || 'none'}`,
    '',
    'Reviews (ref | palate | rating | text):',
    ...lines,
    '',
    'Return JSON with exactly these keys:',
    '{',
    '  "headline": "one line, under 80 characters, how this place suits the reader",',
    '  "summary": "2–3 sentences on what reviewers who share the reader\'s palate think",',
    '  "agree": "one line on where reviewers of different palates agree",',
    '  "group_takeaways": { "<group slug>": "one-line takeaway for that group" },',
    '  "themes": [ { "label": "1–3 word theme", "detail": "one line", "quote": "exact words or null", "review_refs": ["r1", "r4"] } ]',
    '}',
    `Give up to ${READING_MAX_THEMES} themes, most mentioned first. Each theme must cite the reviews that mention it.`,
  ].join('\n')

  return { system, user, refs }
}

function describeGap(facts: ReadingFacts): string {
  const a = facts.circles.avg
  const b = facts.overall.avg
  if (a == null || b == null || !facts.circles.unlocked) return 'not enough reviews to compare'
  const gap = a - b
  if (gap >= 0.3) return 'they like it more than everyone else'
  if (gap <= -0.3) return 'they like it less than everyone else'
  return 'about the same as everyone else'
}

// ---------------------------------------------------------------------------
// Model output → validated text
// ---------------------------------------------------------------------------

export type ReadingTheme = {
  label: string
  detail: string
  quote: string | null
  sentiment: 'positive' | 'mixed'
  /** Counted by the backend from the cited reviews. */
  review_count: number
  /** First-party review ids, for the filtered review list. */
  review_ids: string[]
}

export type ReadingText = {
  headline: string
  summary: string
  agree: string
  group_takeaways: Record<string, string>
  themes: ReadingTheme[]
}

/** A score or rating written as text ("4.5", "4/5", "5 stars", "90%"). */
const NUMBER_CLAIM = /\b\d+(\.\d+)?\s*(\/\s*5|stars?|out of|points?|%)|\b\d\.\d\b/i

function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.length > max || NUMBER_CLAIM.test(text)) return null
  return text
}

const normalizeForMatch = (s: string) =>
  s.toLowerCase().replace(/[“”"‘’'`]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

export function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Model reply had no JSON object')
  return JSON.parse(trimmed.slice(start, end + 1))
}

/**
 * Validate the model's JSON. Throws when the required text is missing or breaks the rules; themes
 * and takeaways that fail checks are dropped rather than failing the whole reading.
 */
export function validateReadingText(raw: unknown, facts: ReadingFacts, refs: Map<string, ReviewText>): ReadingText {
  if (!raw || typeof raw !== 'object') throw new Error('Model reply was not an object')
  const obj = raw as Record<string, unknown>

  const headline = cleanLine(obj.headline, 110)
  const summary = cleanLine(obj.summary, 520)
  if (!headline || !summary) throw new Error('Model reply is missing a usable headline or summary')
  const agree = cleanLine(obj.agree, 200) ?? ''

  const group_takeaways: Record<string, string> = {}
  const takeawaysRaw = obj.group_takeaways && typeof obj.group_takeaways === 'object' ? (obj.group_takeaways as Record<string, unknown>) : {}
  for (const group of facts.your_groups) {
    const line = cleanLine(takeawaysRaw[group.slug], 160)
    if (line) group_takeaways[group.slug] = line
  }

  const themes: ReadingTheme[] = []
  const themesRaw = Array.isArray(obj.themes) ? obj.themes : []
  for (const item of themesRaw) {
    if (themes.length >= READING_MAX_THEMES) break
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const label = cleanLine(t.label, 40)
    const detail = cleanLine(t.detail, 160)
    if (!label || !detail) continue

    const cited = [...new Set(Array.isArray(t.review_refs) ? t.review_refs.map(String) : [])]
      .map((ref) => refs.get(ref.trim()))
      .filter((r): r is ReviewText => Boolean(r))
    if (cited.length === 0) continue

    let quote: string | null = null
    if (typeof t.quote === 'string' && t.quote.trim()) {
      const q = t.quote.replace(/^["“'‘]+|["”'’]+$/g, '').replace(/\s+/g, ' ').trim()
      const words = q.split(' ').length
      const needle = normalizeForMatch(q)
      if (words <= QUOTE_MAX_WORDS && needle && cited.some((r) => normalizeForMatch(r.text).includes(needle))) {
        quote = q
      }
    }

    const avg = cited.reduce((sum, r) => sum + r.rating, 0) / cited.length
    themes.push({
      label,
      detail,
      quote,
      sentiment: avg >= 4 ? 'positive' : 'mixed',
      review_count: cited.length,
      review_ids: cited.filter((r) => r.source === 'first_party').map((r) => r.id),
    })
  }

  return { headline, summary, agree, group_takeaways, themes }
}

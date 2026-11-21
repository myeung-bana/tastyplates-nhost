import {
  groupPoolByRestaurant,
  leafIdsForSlugs,
  type PoolEntry,
  reviewerHasAnyLeaf,
  scorePool,
} from './reviewPool'
import { loadReviewPool } from './reviewPoolLoader'

/**
 * Rating Model v3 — live Your / Search / Shared scores.
 *
 * Reviewers whose palate is one of the requested cuisines (region slugs expand to their cuisines),
 * scored from the review pool: native × 2 + scraped × 1, drafts and rejected excluded, no Google
 * aggregate, no row cap. A reviewer with two requested palates counts once.
 *
 * Response shape is unchanged: `{ [restaurant_uuid]: { avg, count } }`, where `avg` is the weighted
 * average shown to users and `count` is the number of reviews (unlock thresholds use it).
 */

export type PreferenceStatsMap = Record<string, { avg: number; count: number }>

function normalizePalateList(raw: string[]): string[] {
  return [...new Set(raw.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort()
}

/** Score already-loaded pool entries for a set of palate slugs. */
export function preferenceStatsFromEntries(
  entries: readonly PoolEntry[],
  leafIds: ReadonlySet<number>,
): PreferenceStatsMap {
  const out: PreferenceStatsMap = {}
  if (leafIds.size === 0) return out

  const filter = reviewerHasAnyLeaf(leafIds)
  for (const [uuid, restaurantEntries] of groupPoolByRestaurant(entries)) {
    const score = scorePool(restaurantEntries, filter)
    if (score.review_count > 0 && score.display_avg != null) {
      out[uuid] = { avg: score.display_avg, count: score.review_count }
    }
  }
  return out
}

export async function aggregatePreferenceStatsByPalates(
  palateSlugs: string[],
  options?: { restaurantUuids?: string[] },
): Promise<PreferenceStatsMap> {
  const palates = normalizePalateList(palateSlugs)
  if (palates.length === 0) return {}

  const { entries, taxonomy } = await loadReviewPool({ restaurantUuids: options?.restaurantUuids })
  const leafIds = leafIdsForSlugs(palates, taxonomy, { expandRegions: true })
  return preferenceStatsFromEntries(entries, leafIds)
}

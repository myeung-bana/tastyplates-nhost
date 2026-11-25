/**
 * Restaurant detail scores for one viewer — pure logic, no I/O.
 *
 * Every number comes from the Rating Model v3 review pool (`reviewPool.ts`), with the same filters
 * Shared and reviewer-group scores already use. The app only displays the result; it no longer
 * decides which palate score to show.
 *
 * Palate score choice (first that applies):
 *   1. one of the viewer's cuisines is a cuisine of the restaurant → "Your Score · Korean"
 *      (reviewers who grew up with that cuisine);
 *   2. one of the viewer's cuisines shares a region with the restaurant → "East Asian Score"
 *      (reviewers from that region);
 *   3. a reviewer group that contains one of the viewer's cuisines → "<Group> Score"
 *      (the group with the most reviews here).
 * Guests and viewers without palates get no palate score.
 */
import {
  type CuisineTaxonomy,
  type PoolEntry,
  type PoolScore,
  reviewerHasAnyLeaf,
  reviewerInAnyRegion,
  reviewerMatchesRestaurantCuisines,
  scorePool,
} from './reviewPool'

/** Same unlock threshold as Shared and group scores. */
export const SCORE_MIN_REVIEWS = 3

export type ScoreGroup = { slug: string; name: string; member_cuisine_ids: readonly number[] }

export type ScoreCard = {
  avg: number | null
  review_count: number
  unlocked: boolean
}

export type PalateScoreCard = ScoreCard & {
  kind: 'palate' | 'region' | 'group'
  /** Ready to show, e.g. "Your Score · Korean" or "East Asian Score". */
  label: string
  /** Who the score is from, e.g. "Reviewers who grew up with Korean food". */
  caption: string
}

export type RestaurantScores = {
  min_reviews: number
  overall: ScoreCard
  /** Null for guests and viewers without palates. */
  palate: PalateScoreCard | null
  authentic: ScoreCard
  /** Null for guests. Locked under {@link SCORE_MIN_REVIEWS} reviews from the viewer's palates. */
  shared: (ScoreCard & { caption: string }) | null
}

const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

function card(score: PoolScore, alwaysUnlocked = false): ScoreCard {
  return {
    avg: round2(score.display_avg),
    review_count: score.review_count,
    unlocked: alwaysUnlocked || score.review_count >= SCORE_MIN_REVIEWS,
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function computeRestaurantScores(input: {
  entries: readonly PoolEntry[]
  taxonomy: CuisineTaxonomy
  restaurantCuisines: { leafIds: ReadonlySet<number>; regionIds: ReadonlySet<number> }
  /** Viewer's leaf palate ids; null for guests. */
  viewerLeafIds: ReadonlySet<number> | null
  groups: readonly ScoreGroup[]
}): RestaurantScores {
  const { entries, taxonomy, restaurantCuisines, viewerLeafIds, groups } = input

  const overall = card(scorePool(entries), true)
  const authentic = card(scorePool(entries, reviewerMatchesRestaurantCuisines(restaurantCuisines)), true)

  if (!viewerLeafIds) {
    return { min_reviews: SCORE_MIN_REVIEWS, overall, palate: null, authentic, shared: null }
  }

  const viewerLeaves = [...viewerLeafIds]
  const viewerNames = viewerLeaves.map((id) => taxonomy.byId.get(id)?.name).filter((n): n is string => Boolean(n))
  const sharedScore = scorePool(entries, reviewerHasAnyLeaf(viewerLeaves))
  const shared = {
    ...card(sharedScore),
    caption: viewerNames.length
      ? `Reviewers who grew up with ${joinNames(viewerNames)} food`
      : 'Reviewers who share your palate',
  }

  if (viewerLeaves.length === 0) {
    return { min_reviews: SCORE_MIN_REVIEWS, overall, palate: null, authentic, shared }
  }

  let palate: PalateScoreCard | null = null

  // 1. The viewer grew up with one of this restaurant's cuisines.
  const matchingLeaves = viewerLeaves.filter((id) => restaurantCuisines.leafIds.has(id))
  if (matchingLeaves.length > 0) {
    const names = matchingLeaves.map((id) => taxonomy.byId.get(id)?.name ?? '').filter(Boolean)
    palate = {
      ...card(scorePool(entries, reviewerHasAnyLeaf(matchingLeaves))),
      kind: 'palate',
      label: `Your Score · ${names[0] ?? 'Your palate'}`,
      caption: `Reviewers who grew up with ${joinNames(names)} food`,
    }
  }

  // 2. Same region as the restaurant (e.g. Korean palate at a Japanese place → East Asian).
  if (!palate) {
    const restaurantRegions = new Set<number>(restaurantCuisines.regionIds)
    for (const leafId of restaurantCuisines.leafIds) {
      const parent = taxonomy.byId.get(leafId)?.parent_id
      if (parent != null) restaurantRegions.add(parent)
    }
    const regions = [
      ...new Set(
        viewerLeaves
          .map((id) => taxonomy.byId.get(id)?.parent_id)
          .filter((id): id is number => id != null && restaurantRegions.has(id)),
      ),
    ]
    if (regions.length > 0) {
      const name = taxonomy.byId.get(regions[0]!)?.name ?? 'Regional'
      palate = {
        ...card(scorePool(entries, reviewerInAnyRegion(regions.slice(0, 1)))),
        kind: 'region',
        label: `${name} Score`,
        caption: `Reviewers who grew up with ${name} food`,
      }
    }
  }

  // 3. A reviewer group holding one of the viewer's cuisines — the one with the most reviews here.
  if (!palate) {
    let best: { group: ScoreGroup; score: PoolScore } | null = null
    for (const group of groups) {
      if (!group.member_cuisine_ids.some((id) => viewerLeafIds.has(id))) continue
      const score = scorePool(entries, reviewerHasAnyLeaf(group.member_cuisine_ids))
      if (!best || score.review_count > best.score.review_count) best = { group, score }
    }
    if (best) {
      palate = {
        ...card(best.score),
        kind: 'group',
        label: `${best.group.name} Score`,
        caption: `Reviewers who grew up with ${best.group.name} food`,
      }
    }
  }

  return { min_reviews: SCORE_MIN_REVIEWS, overall, palate, authentic, shared }
}

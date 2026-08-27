# Pre-computed Palate Ratings (v2)

Design direction for ranking restaurants by **reviewer palate identity** — e.g. "restaurants that people with **Chinese palate** rate highly."

**Status:** Implemented for admin reads/rebuilds; mobile browse integration remains planned

**Audience:** Product, backend engineers, mobile/web engineers

**Supersedes:** `precompute-ratings.md` (v1) — this version keeps the original table shape and attribution rules, and fixes three architecture issues found in review (combined-row math, client-side fallback logic, undefined `reviewer_count`), plus adds the Nhost function set, client/admin fetch design, and a rebuild-automation roadmap that v1 didn't cover.

**Related docs:**
- [score-calculation.md](./score-calculation.md) — existing Overall, Authentic, Search/Your, Shared scores; §16 "Rebuild automation" is the companion doc for the automation roadmap in §13 below
- [migrations/add_restaurant_external_reviews.md](./migrations/add_restaurant_external_reviews.md) — external review rows + `author_palates`
- [migrations/add_restaurant_external_review_summary.md](./migrations/add_restaurant_external_review_summary.md) — external aggregate signals (taste tags, not reviewer palates)

---

## 1. The customer journey

A user with **Chinese palate** should discover restaurants ranked by how highly **other reviewers with Chinese palate** (or related palates) have rated them — not by how the restaurant is tagged.

This is **reviewer-identity ranking**, distinct from restaurant taxonomy:

| Metric | Question it answers |
|--------|---------------------|
| **Overall** | "What does everyone think?" |
| **Authentic** | "Do people whose palates match *this restaurant's* cuisine tags think it's good?" |
| **Search / Your / Shared** (live) | "Would people with palates like mine enjoy this?" — computed on demand today |
| **Palate rating (proposed)** | "How highly do people with **Chinese palate** rate this restaurant?" |

---

## 2. Palate taxonomy

Reviewer palates use the same cuisine-identity leaf slugs as `user_profiles.palates` and
`restaurant_cuisines` (e.g. `chinese`, `korean`, `indian`). This is the taxonomy managed by
`/dashboard/admin/manage-cuisine`. Users pick up to **2 leaf identities**.

`restaurant_palates` is a separate flavor/taste taxonomy (for example `sweet`, `spicy`, and
`umami`) and must not be used for reviewer identity aggregation.

Parent umbrella groups (pre-computed rollups):

| Parent | Example leaf palates |
|--------|----------------------|
| African | ethiopian, nigerian, … |
| East Asian | chinese, japanese, korean, taiwanese |
| European | … |
| Middle Eastern | lebanese, turkish, iranian, … |
| North American | … |
| Oceanic | … |
| South Asian | indian, pakistani, nepalese, … |
| South East Asian | malaysian, filipino, singaporean, indonesian |

Hierarchy is stored in `restaurant_cuisines`:

- **Parent:** `parent_id IS NULL`
- **Leaf:** `parent_id` points to a parent row

Mobile/web reference: `palateOptions` / `GET /api/v1/cuisines/get-cuisines?leafOnly=true`

---

## 3. Review sources

### External reviews (phase 1)

Table: `restaurant_external_reviews`

| Column | Role |
|--------|------|
| `author_palates` | Ethnic/cuisine reviewer identity (leaf slugs, max 2) |
| `palates` | Taste/flavor tags from review text (spicy, umami, …) — **not** used for this metric |
| `rating` | 1–5 star rating |
| `is_flagged` | Excluded when `true` |

Rebuild input: non-flagged rows with non-empty `author_palates`.

### First-party reviews (phase 2)

Table: `restaurant_reviews` + `user_profiles.palates` on the review author.

Rebuild input: approved, non-deleted, top-level reviews where the author's profile palates (fallback: review snapshot `palates`) are resolved.

Same attribution logic as live `get-preference-stats` in `functions/_lib/preference-stats-aggregate.ts`, but **pre-computed per restaurant** instead of scanning all reviews at query time.

---

## 4. Table: `restaurant_palate_rating_summary`

Normalized, indexed rows for fast cross-restaurant ranking (JSON breakdown alone is not sufficient at scale).

> **v2 change:** `review_source` no longer includes `'combined'` as a stored value. Bayesian-smoothed
> `rating_weighted` values cannot be correctly summed or averaged across sources — smoothing is
> non-linear (`(sum + m·global) / (count + m)`), so a naively "merged" combined row would silently
> drift from what a fresh recompute produces. `combined` is now a derived view (§4b) computed from
> raw `rating_sum`/`review_count`, smoothed exactly once. This also means every rebuild trigger only
> ever touches `external` or `first_party` rows — never a third row to keep in sync.

```sql
CREATE TABLE public.restaurant_palate_rating_summary (
  restaurant_id       bigint        NOT NULL
    REFERENCES public.restaurants (id) ON DELETE CASCADE,

  cuisine_id          integer       NOT NULL
    REFERENCES public.restaurant_cuisines (id) ON DELETE CASCADE,

  review_source       text          NOT NULL
    CHECK (review_source IN ('first_party', 'external')),

  review_count        integer       NOT NULL DEFAULT 0,
  rating_sum          numeric(12,4) NOT NULL DEFAULT 0,
  rating_avg          numeric(4,2),
  rating_weighted      numeric(6,4),

  -- COUNT(DISTINCT author_identifier) among qualifying reviews for this
  -- (restaurant, palate, source). Diverges from review_count as soon as one
  -- reviewer leaves multiple reviews for the same restaurant — plausible with
  -- scraped external data (same Google user reviewing repeatedly over time).
  reviewer_count       integer       NOT NULL DEFAULT 0,

  review_version       bigint        NOT NULL,
  updated_at           timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (restaurant_id, cuisine_id, review_source)
);
```

**Indexes (discovery):**

```sql
CREATE INDEX idx_rprs_palate_rank
  ON public.restaurant_palate_rating_summary (cuisine_id, review_source, rating_weighted DESC NULLS LAST)
  WHERE review_count > 0;
```

### Why separate `review_source` rows?

- Ship **external-only** aggregates first without waiting for first-party volume.
- Keep provenance for tuning blend weights later.
- `combined` = derived from `first_party` + `external` raw sums (§4b) — never independently stored.

### Leaf vs parent rows

Both are rows in `restaurant_cuisines`:

- **Leaf** (`chinese`) — primary UX for "Chinese Palate" discovery.
- **Parent** (`East Asian`) — browse broader region; fallback when leaf data is sparse.

---

## 4b. Derived views: `combined` and leaf→parent fallback

> **v2 addition.** Both of these push logic that v1 left implicit (§7/§8 of v1) down into
> Postgres/Hasura, so mobile and web never have to duplicate a two-query dance or a
> re-implemented smoothing formula. This also matches the mobile architecture rule of
> no BFF layer — the client makes one request; the fallback and blend logic live server-side.

### Combined view (correct smoothing, computed once)

```sql
CREATE VIEW public.restaurant_palate_rating_summary_combined AS
SELECT
  restaurant_id,
  cuisine_id,
  SUM(review_count)               AS review_count,
  SUM(rating_sum)                 AS rating_sum,
  ROUND(SUM(rating_sum) / NULLIF(SUM(review_count), 0), 2) AS rating_avg,
  ROUND(
    (SUM(rating_sum) + 4.0 * 5) / (SUM(review_count) + 5),
    4
  ) AS rating_weighted, -- GLOBAL_MEAN = 4.0, CONFIDENCE_M = 5, per score-calculation.md §7
  SUM(reviewer_count)              AS reviewer_count -- upper bound; a reviewer counted in both
                                                       -- sources is double-counted here, acceptable
                                                       -- for phase 1/2 display purposes
FROM public.restaurant_palate_rating_summary
GROUP BY restaurant_id, cuisine_id;
```

Track this view in Hasura like any model. If Bayesian constants ever diverge between sources, this is the one place to change the formula.

### Leaf→parent fallback (sparse-data)

```sql
CREATE VIEW public.restaurant_palate_rating_effective AS
SELECT
  leaf_summary.restaurant_id,
  leaf.id                          AS requested_cuisine_id,
  leaf.slug                        AS requested_palate_slug,
  COALESCE(
    NULLIF(leaf_summary.cuisine_id, NULL) FILTER (WHERE leaf_summary.review_count >= 3),
    parent_summary.cuisine_id
  )                                 AS resolved_cuisine_id,
  CASE WHEN leaf_summary.review_count >= 3
       THEN leaf.slug ELSE parent.slug END                AS resolved_palate_slug,
  CASE WHEN leaf_summary.review_count >= 3
       THEN FALSE ELSE TRUE END                            AS is_fallback,
  COALESCE(
    leaf_summary.rating_weighted FILTER (WHERE leaf_summary.review_count >= 3),
    parent_summary.rating_weighted
  )                                 AS rating_weighted,
  COALESCE(
    leaf_summary.review_count FILTER (WHERE leaf_summary.review_count >= 3),
    parent_summary.review_count
  )                                 AS review_count
FROM public.restaurant_cuisines leaf
JOIN public.restaurant_cuisines parent ON leaf.parent_id = parent.id
LEFT JOIN public.restaurant_palate_rating_summary_combined leaf_summary
  ON leaf_summary.cuisine_id = leaf.id
LEFT JOIN public.restaurant_palate_rating_summary_combined parent_summary
  ON parent_summary.cuisine_id = parent.id AND parent_summary.restaurant_id = leaf_summary.restaurant_id
WHERE leaf.parent_id IS NOT NULL;
```

(Sketch — the applied migration uses `restaurant_cuisines` and cross-joins restaurants so parent
fallback also works when a leaf has no row. The `3`-review threshold must stay aligned with the
server constant.)

### Helper view (leaf/parent lookup)

```sql
CREATE VIEW public.cuisine_leaf_to_parent AS
SELECT
  leaf.id   AS leaf_cuisine_id,
  leaf.slug AS leaf_slug,
  parent.id AS parent_cuisine_id,
  parent.slug AS parent_slug
FROM public.restaurant_cuisines leaf
JOIN public.restaurant_cuisines parent ON leaf.parent_id = parent.id;
```

---

## 5. Rebuild algorithm

```
For each restaurant:
  For each review source (external, then first_party):
    Scan qualifying reviews
    For each review with rating R and reviewer leaf palates [P1, P2]:
      → increment leaf buckets for P1 and P2
      → increment parent bucket once per distinct parent of P1/P2
      → track DISTINCT author_identifier per bucket for reviewer_count
    Compute rating_avg, rating_weighted (Bayesian, m=5, global=4.0)
    Upsert rows for (restaurant_id, cuisine_id, review_source)
  # No separate "merge into combined" step — combined is the view in §4b,
  # computed on read from the two upserted rows above.
```

### Attribution rules

1. **Leaf:** a review with `author_palates = ['chinese', 'korean']` contributes to **both** leaf buckets (matches user identity model).
2. **Parent:** same review contributes **once** per parent — `chinese` + `korean` both roll up to East Asian → one East Asian increment.
3. **Scoring:** reuse Bayesian smoothing from [score-calculation.md](./score-calculation.md) (`GLOBAL_MEAN = 4.0`, `CONFIDENCE_M = 5`) — see the open question in §9.3 on whether these constants should differ for leaf-grain vs parent-grain rows.
4. **Threshold:** expose `review_count`; UI/API can require e.g. `review_count >= 3` before showing in ranked lists (also the trigger for leaf→parent fallback in §4b).

---

## 6. Rebuild triggers

| Event | Action |
|-------|--------|
| External review create / update / delete | Rebuild `external` for that restaurant (combined view updates automatically on read) |
| External `author_palates` change | Same |
| First-party review approved / updated / deleted | Rebuild `first_party` for that restaurant |
| User profile `palates` change | Rebuild affected restaurants (reviews by that author) — **note:** the algorithm above is a full rescan per restaurant, not an incremental delta, so one profile edit by an active reviewer fans out to N full rescans, one per restaurant they've reviewed. Fine at current scale (80 restaurants); revisit if reviewer activity grows. |

Server-side implementation — see §11 for the concrete function set and hook points (grounded against the actual `tastyplates-nhost` codebase, not just proposed names):

- `functions/_lib/rebuildRatingSummary.ts` — Overall + Authentic (existing)
- `functions/_lib/rebuildExternalReviewSummary.ts` — external taste/sentiment aggregates (existing)
- **`functions/_lib/rebuildPalateRatingSummary.ts`** — new (proposed, §11)

Portal admin handlers mirror the same logic under `tasty-business-portal/src/lib/admin-handlers/` (§12).

---

## 7. Query patterns

### Discover by leaf palate (with automatic fallback)

```sql
SELECT r.uuid, r.name, e.rating_weighted, e.review_count, e.resolved_palate_slug, e.is_fallback
FROM restaurant_palate_rating_effective e
JOIN restaurants r ON r.id = e.restaurant_id
WHERE e.requested_palate_slug = 'chinese'
ORDER BY e.rating_weighted DESC, e.review_count DESC;
```

`is_fallback = true` means the row is showing the East Asian parent score because Chinese-leaf data was sparse — surface that in the UI (§12) rather than silently relabeling.

### Parent browse ("East Asian")

Query `restaurant_palate_rating_summary_combined` directly by parent `cuisine_id` — no fallback needed, parent rows are the terminal case.

### One-restaurant lookup (detail screen)

```sql
SELECT rating_weighted, rating_avg, review_count, is_fallback, resolved_palate_slug
FROM restaurant_palate_rating_effective
WHERE restaurant_id = $1 AND requested_palate_slug = $2;
```

This is what `get-palate-rating-summary` (§12) wraps.

---

## 8. What this is not

| Existing artifact | Why it's different |
|-------------------|-------------------|
| `restaurant_external_review_summary.palate_breakdown` | Counts **taste tags** (`palates`: spicy, umami), not reviewer ethnic identity |
| `restaurant_rating_summary.authentic_*` | Matches reviewer palates to **restaurant** taxonomy, not "people like me rated this highly" |
| Live `get-preference-stats` | Same *intent* as this design, but scans reviews at request time (limit 5000) — pre-computation replaces that for browse/ranking |

---

## 9. Open decisions

1. **Parent slug normalization** — ensure DB parent slugs are stable (`east-asian`) vs display labels (`East Asian`).
2. **Combined blend weights** — equal weight vs trust first-party more than external. (Resolved at the *mechanism* level in v2 — combined is always a correctly-smoothed derived view, §4b — but the product question of whether to weight first-party reviews more heavily than external ones is still open.)
3. **Bayesian constants at leaf grain** — `GLOBAL_MEAN=4.0, m=5` was calibrated against Overall/Authentic review volume. Leaf-grain palate buckets will often have `review_count` of 1–3 even at moderate restaurant volume, so every sparse leaf regresses hard toward 4.0 — differentiation could disappear exactly for the "niche palate discovery" case this feature exists to serve. Should `m` be smaller for leaf rows than parent rows?
4. **Google prior** — Overall/Search fold in Google aggregates today; palate ratings likely stay **reviewer-attributed only** (no Google block), since Google doesn't expose reviewer ethnic identity.
5. **Minimum review threshold** — product default (currently `3` in §4b's fallback view, matching Shared Score's threshold in score-calculation.md §6) for showing ranked scores vs falling back to parent vs "Not enough data."
6. **Rebuild trigger mechanism** — ship Phase A only (in-handler `schedulePalateRatingSummaryRebuild`, consistent with Overall/Authentic/external today, §13), or go straight to Phase B (Hasura Event Triggers) given this table has more write paths from day one (external ingest + first-party reviews + profile edits, §6)?
7. **Optional audit table** — `restaurant_palate_review_contributions` for explainability ("which reviews drove this score?") — defer unless needed.

---

## 10. Rollout plan

| Phase | Scope |
|-------|--------|
| **1** | Migration + `restaurant_palate_rating_summary` + `_combined`/`_effective` views; rebuild from **external** `author_palates` only |
| **2** | Add **first_party** source from `user_profiles.palates` |
| **3** | Wire mobile "Discover by palate" to `restaurant_palate_rating_effective`; ship fallback UI treatment |
| **4** | Replace or supplement live `get-preference-stats` with pre-computed reads; admin backfill job |

---

## 11. Nhost function set (server-side)

> **v2 addition.** Grounded against the actual `tastyplates-nhost` repo — `rebuildRatingSummary.ts`,
> `rebuildExternalReviewSummary.ts`, and `admin/backfill-rating-summary.ts` all follow one
> consistent pattern; this proposal follows the same shape rather than inventing a new one.

New file `functions/_lib/rebuildPalateRatingSummary.ts`:

```typescript
export async function rebuildPalateRatingSummary(
  restaurantUuid: string,
  source: 'external' | 'first_party'
): Promise<boolean> { /* scan + upsert, per §5 algorithm */ }

export async function rebuildAllPalateRatingSummaries(
  source?: 'external' | 'first_party'
): Promise<number> { /* backfill loop, mirrors rebuildAllExternalReviewSummaries */ }

/** Fire-and-forget rebuild — never throws to HTTP handlers, matches scheduleRatingSummaryRebuild */
export function schedulePalateRatingSummaryRebuild(restaurantUuid: string, source: 'external' | 'first_party'): void { }

export function schedulePalateRatingSummaryRebuildMany(restaurantUuids: string[], source: 'external' | 'first_party'): void { }
```

Wired into **existing** handlers — no new infra required for Phase A (§13):

| Handler | Call added | Phase |
|---|---|---|
| `restaurant-reviews/create-review.ts`, `update-review.ts`, `delete-review.ts` | `schedulePalateRatingSummaryRebuild(uuid, 'first_party')` | 2 |
| `admin/moderate-review.ts` | same — approval changes eligibility | 2 |
| external review ingest (`externalReviewIngest.ts`, `admin-external-data-handlers.ts`) | `schedulePalateRatingSummaryRebuild(uuid, 'external')` | 1 |
| `admin/update-user-profile.ts` (`body.palates`, line ~84) | look up restaurants this author has reviewed → `schedulePalateRatingSummaryRebuildMany(uuids, 'first_party')` | 2 |

---

## 12. Client fetch (mobile/web)

Two endpoints under `functions/restaurants-v2/`, both thin handlers over a shared `_lib` query helper (`getEffectivePalateRating`) that queries `restaurant_palate_rating_effective` (§4b/§7) in one indexed round trip — the leaf→parent fallback logic lives here, server-side, not duplicated in client code:

- **`get-palate-rating-summary.ts`** — `?restaurant_uuid=&palate_slug=` — single restaurant, mirrors `get-rating-summary`. Response:

  ```json
  {
    "ok": true,
    "data": {
      "rating_avg": 4.6,
      "rating_weighted": 4.35,
      "review_count": 8,
      "resolved_palate_slug": "east-asian",
      "is_fallback": true
    }
  }
  ```

  Mobile detail screen adds a `usePalateRatingSummary()` hook alongside the existing `useRestaurantScores.ts`.

- **Extend `get-restaurants.ts`** rather than add a new browse endpoint — `order_by=palate&palate_slug=chinese`, same slot `order_by=smart` already uses for `authentic_rating_weighted`. Gets filtering/pagination for free instead of reimplementing it.

`is_fallback: true` should render as something like "Based on East Asian palate (limited Chinese-palate data)" rather than silently relabeling the score.

---

## 13. Admin side (MCP connector)

New tools on `tastyplates-admin`, matching the existing naming convention exactly (`rebuild_rating_summary`, `backfill_rating_summaries`, `get_cuisine_rating_summary`):

- `get_palate_rating_summary` — inspect one restaurant/palate (leaf or parent, resolved or raw)
- `rebuild_palate_rating_summary` — manual single-restaurant trigger
- `backfill_palate_rating_summaries` — bulk, mirrors `functions/admin/backfill-rating-summary.ts` exactly (same `x-admin-secret` guard via `ADMIN_SECRET`, same `ok()/fail()` envelope from `_lib/respond.ts`)

---

## 14. Rebuild automation — current state and roadmap

> **v2 addition.** Cross-referenced with [score-calculation.md](./score-calculation.md) §16, which
> documents this same gap for the *existing* Overall/Authentic/external rebuilds — it isn't unique
> to the palate feature.

### How rebuilds actually fire today (confirmed against the repo)

All rebuilds are triggered **synchronously in-process**, from inside the HTTP handler that performed the write (`scheduleRatingSummaryRebuild` is a fire-and-forget async call, not a queue). There is **no Hasura Event Trigger and no cron function in this repo today.** Any write that doesn't go through one of these Nhost Function handlers — Apify ingest scripts writing `restaurant_external_reviews` directly, manual Hasura console edits, future batch tooling — never triggers a rebuild, and summaries go stale silently until someone runs the relevant `admin/backfill-*` endpoint by hand.

### Phased plan

| Phase | Mechanism | When |
|-------|-----------|------|
| **A (default for palate ratings, phase 1 rollout)** | In-handler `schedulePalateRatingSummaryRebuild()`, fire-and-forget — consistent with how Overall/Authentic/external work today | Now |
| **B** | Hasura Event Triggers on `restaurant_reviews`, `restaurant_external_reviews`, `user_profiles` → dedicated Nhost Function webhook | When ingest paths multiply and Phase A's blind spots start causing visible staleness — palate ratings have more write paths from day one (external ingest + first-party + profile edits) than Overall/Authentic did, so this may come sooner here (open decision §9.6) |
| **C** | Scheduled/cron Nhost Function — nightly full rebuild across all restaurants | Once Phase B exists, as a drift-correction backstop, not a replacement for it — the rebuild algorithm is a full table scan per restaurant (§5), not incremental, so this is cheap to run nightly but not something to lean on as the primary trigger |

**Not proposed:** a message queue or separate worker service — new infrastructure beyond what Nhost provides natively, and inconsistent with the "stay close to existing patterns" convention already established in this codebase.

---

## 15. Next implementation steps

1. Apply the cuisine-taxonomy correction migration and rebuild all derived rows.
2. Track table and views in Hasura; permissions: public/user **select** on aggregate columns only.
3. Implement `rebuildPalateRatingSummary` + `schedulePalateRatingSummaryRebuild*` in `functions/_lib/` (§11); wire into the four handlers listed there.
4. Implement `get-palate-rating-summary.ts` and extend `get-restaurants.ts` with `order_by=palate` (§12).
5. Add the three MCP admin tools (§13) to `tastyplates-business-portal`.
6. Resolve open decision §9.6 (Phase A vs B for rebuild triggers) before or shortly after phase 1 ships.
7. Document final HTTP contract in [api-guide.md](./api-guide.md) once shipped.
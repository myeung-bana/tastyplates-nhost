# TastyPlates — Score Calculation

Product and engineering guide for how restaurant ratings are computed, stored, displayed, and used for ranking.

**Audience:** Product, design, mobile/web engineers, and anyone answering "where does this number come from?"

**Authoritative backend:** `tastyplates-nhost/functions/_lib/` (mobile app uses Nhost functions). The legacy web app (`tastyplates-v2-1`) has parallel logic with some differences noted below.

**Related docs:** [api-guide.md](./api-guide.md) (HTTP endpoints), [api-doc-v4.md](./api-doc-v4.md) (deploy + overview), [precompute-ratings-v2.md](./precompute-ratings-v2.md) (proposed palate-identity ranking — builds on §7 Bayesian smoothing and §11 rebuild automation below)

---

## 1. The big picture

TastyPlates is not a single "star rating" product. Every restaurant can show up to **four different scores**, each answering a different question:

| Score | Plain-English question | Who sees it |
|-------|------------------------|-------------|
| **Overall** | "What does everyone think?" | Everyone |
| **Authentic** | "Do people who actually eat this type of food think it's good?" | Everyone |
| **Search / Your** | "Would people with a palate like mine enjoy this?" | Guests browsing a cuisine; signed-in users get **Your Score** |
| **Shared** | "Do people with my exact palate think it's good?" | Signed-in users only (mobile: ≥ 3 matching reviews) |

Think of it as zooming in on the reviewer pool:

```
Overall        → all reviewers (+ Google on mobile backend)
Authentic      → reviewers whose palate matches the restaurant's cuisine
Search / Your  → reviewers in a broader "trust set" (sibling cuisines in your region)
Shared         → reviewers with your exact profile palates
```

Each zoom level is **more personal** but usually has **fewer reviews**, so we apply different visibility rules (especially Shared Score).

---

## 2. Where ratings come from

### TastyPlates reviews

- Users submit reviews with a **half-star rating** from **0.5 to 5.0** (in 0.5 steps).
- Only **top-level** reviews count (replies are excluded).
- Deleted reviews (`deleted_at` set) are excluded.
- **Overall** and **Authentic** rebuilds use **`status = approved`** only.
- Reviewer identity for palate matching:
  1. **Primary:** `user_profiles.palates` on the review author (`AuthorProfile` in API responses)
  2. **Fallback:** `palates` snapshot stored on the review row at write time

### Google Places (mobile backend)

When a TastyPlates restaurant is linked to Google (`google_place_cache`):

- We store Google's **aggregate** star rating and **total review count** — not individual Google review rows in our aggregates.
- On the **Nhost backend**, this aggregate is **folded into**:
  - **Overall Score** (per restaurant rebuild)
  - **Search / Shared / preference stats** (live aggregation across all linked restaurants)

**Human explanation:** If a restaurant has 3 TastyPlates reviews averaging 4.8 and Google shows 4.5 stars from 1,000 people, the Overall Score blends both pools so new listings are not stuck at "3 reviews" forever. We are not importing 1,000 Google reviews one-by-one — we treat Google as one weighted block.

**Browse cards:** When a row has no TastyPlates reviews yet, the card may show **`google_rating`** directly from Places data.

---

## 3. Overall Score

### What it means

> "What platform users (and Google, when linked) think of this restaurant overall."

This is the broadest signal — no palate filtering.

### How it's calculated

1. Sum all **approved** TastyPlates review ratings for the restaurant.
2. If linked to Google, add `google_rating × user_ratings_total` to the sum and `user_ratings_total` to the count.
3. **Display value:** `overall_rating_avg = sum / count`
4. **Ranking value:** `overall_rating_weighted` — Bayesian-smoothed (see §7)

### Where it's stored

| Table / column | Purpose |
|----------------|---------|
| `restaurant_rating_summary.overall_rating_avg` | Precomputed display average |
| `restaurant_rating_summary.overall_rating_weighted` | Smoothed value for internal ranking |
| `restaurants.average_rating` | Denormalized copy for fast browse queries |
| `restaurants.ratings_count` | Review count mirror |

### API & UI

- **API:** `GET restaurants-v2/get-rating-summary?restaurant_uuid=`
- **Mobile display:** `overall_rating_avg`, fallback to `restaurants.average_rating`
- **Browse "Highest Rated" sort:** `restaurants.average_rating` DESC
- **Auth:** None required

---

## 4. Authentic Score

### What it means

> "Do people who actually eat this cuisine think the restaurant is good?"

A Korean-palate reviewer rating a Korean restaurant counts. The same person rating an Italian restaurant does **not** count toward Authentic for that Italian place.

### How it's calculated

1. Build the restaurant's **taxonomy** from `restaurants.palates` + `restaurants.cuisines` (normalized slugs).
2. For each approved TastyPlates review, resolve the reviewer's palate slugs (profile first, then review snapshot).
3. Include the review if **any** reviewer palate **fuzzy-matches** **any** restaurant taxonomy slug:
   - Match rule: `a.includes(b) || b.includes(a)` after lowercasing (e.g. `korean` matches `korean-fusion`).
4. **Display value:** `authentic_rating_avg = sum / count` over matching reviews only.
5. **Ranking value:** `authentic_rating_weighted` — Bayesian-smoothed.

Google ratings are **not** folded into Authentic — only real TastyPlates reviewers with matching palates.

### API & UI

- **API:** `GET restaurants-v2/get-rating-summary` → `authentic_rating_avg`
- **Smart Sort** (`order_by=smart` on browse): sorts by `authentic_rating_weighted` DESC — surfaces "cuisine insiders" rate highly even with few reviews (after smoothing).
- **Auth:** None required

### Human example

A ramen shop tagged `japanese` with reviews from users whose palates include `japanese`, `east-asian`, or `ramen` (fuzzy overlap) contributes to Authentic. A reviewer whose only palate is `italian` does not.

---

## 5. Search Score and Your Score

### What it means

> "How much would people with a palate like yours rate this place?"

- **Search Score** — guest or non-personalised: based on the **cuisine you're browsing** (e.g. all `japanese` reviewers when `?cuisine=japanese`).
- **Your Score** — signed-in + personalised: based on your **trust set** — sibling cuisines in the same region that intersect **your** profile palates (not necessarily the cuisine you're browsing).

### Trust set (personalised — mobile)

Implemented in `tastyplates-mobile/lib/cuisineTaxonomy.ts` → `resolveTrustSet()`.

**Example:** You have palates `[korean, japanese]`. You browse Japanese restaurants.

- Browsed cuisine: `japanese`
- Trust set might be: `[korean, japanese, chinese]` — East Asian siblings you share palate overlap with
- **Your Score** averages reviews from reviewers whose profile palates hit **any** slug in the trust set

**Why siblings, not just Japanese?** More data while still being culturally adjacent. Showing only `japanese` reviewers would often yield 0–1 reviews.

**When no cuisine filter is active** (mobile browse home): Search/Your panel is **locked** — user must pick a cuisine context first.

### How it's calculated (live)

**API:** `GET restaurants-v2/get-preference-stats?palates=korean,japanese`

Backend (`functions/_lib/preference-stats-aggregate.ts`):

1. Load up to **5,000** non-deleted, top-level reviews (note: **no `approved` filter** on this path — see §10).
2. For each review, resolve reviewer palates (profile → review fallback).
3. Include if **exact slug match**: `reviewerPalates.some(p => requestedPalateSet.has(p))`.
4. Per restaurant UUID: `avg = sum(ratings) / count`.
5. Merge **Google aggregates** for all linked restaurants into the same buckets (Nhost only).

### API & UI (mobile)

- Hook: `tastyplates-mobile/hooks/useRestaurantScores.ts`
- Component: `RestaurantRatingMetricsRow.tsx`
- Label: **"Your Score"** when `isPersonalised === true`; otherwise **"Search Score"**
- Subtitle: "Rated by N reviewers" vs "What shared preference users think"
- **Auth:** None for API; personalisation requires sign-in + user palates + active cuisine filter

---

## 6. Shared Score

### What it means

> "What do people with my exact palate think?"

Uses **only** the signed-in user's profile palate slugs — no sibling expansion.

**Example:** Profile palates `[korean]` → `get-preference-stats?palates=korean`

### Unlock rule (mobile)

```typescript
SHARED_SCORE_MIN_REVIEWS = 3
```

Shared Score stays **locked** until at least **3** reviews match. This avoids showing a 5.0 from a single friend.

**Copy when locked:** "Sign in to see shared score" (guest) or lock icon when authenticated but count < 3.

### API

Same endpoint as Search: `GET restaurants-v2/get-preference-stats?palates=<user exact palates>`

---

## 7. Bayesian smoothing (internal ranking)

Displayed scores use the **plain average**. For ranking restaurants with very few reviews, we store a **weighted** value that pulls toward the platform mean until enough data exists.

```typescript
GLOBAL_MEAN = 4.0
CONFIDENCE_M = 5

weighted = (avg × count + GLOBAL_MEAN × CONFIDENCE_M) / (count + CONFIDENCE_M)
```

**Human explanation:** A restaurant with one 5-star review would show **5.0** to users but rank lower in Smart Sort than a 4.6 with 40 reviews. The weighted value behaves like "start at 4.0 and move toward the real average as reviews arrive."

| Field | Used for |
|-------|----------|
| `overall_rating_weighted` | Internal / future overall ranking |
| `authentic_rating_weighted` | **Smart Sort** (`order_by=smart`) |

Users always see `*_avg` on the detail score panel, not the weighted number.

> **Note:** [precompute-ratings-v2.md](./precompute-ratings-v2.md) reuses this exact formula for the proposed palate-identity ranking table, with an open question (its §9.3) on whether `CONFIDENCE_M` should be smaller at leaf-palate grain, where review counts per bucket are typically much lower than Overall/Authentic ever see.

---

## 8. Google aggregate merge (formula)

When Google data exists for a linked restaurant:

```
bucket.sum   += google_rating × user_ratings_total
bucket.count += user_ratings_total
display_avg   = bucket.sum / bucket.count
```

**Example:**

| Source | Rating | Count | Contribution |
|--------|--------|-------|---------------|
| TastyPlates reviews | 4.8 avg | 3 | sum +14.4, count +3 |
| Google aggregate | 4.5 | 1000 | sum +4500, count +1000 |
| **Combined** | — | 1003 | **4.5005** overall |

Implementation: `functions/_lib/googleRatingPrior.ts` → `applyGoogleRatingAggregate()`.

---

## 9. Browse ranking modes

| Sort mode | Field / logic | Question it optimises |
|-----------|---------------|----------------------|
| **Highest Rated** | `restaurants.average_rating` DESC | Raw overall popularity |
| **Smart Sort** | `authentic_rating_weighted` DESC | "Insiders of this cuisine rate it highly" |
| **Palate Sort** | Client re-rank via `sortByPalateMatch.ts` | "Best for my palate right now" |

### Palate Sort comparator (client)

Priority order for tie-breaking:

1. `preferenceStat.avg` DESC (missing → sinks to bottom)
2. `preferenceStat.count` DESC
3. `restaurantSearchResultRating()` DESC — TastyPlates overall or Google fallback
4. Review count DESC

---

## 10. Edge cases and known inconsistencies

| Topic | Behaviour |
|-------|-----------|
| **No reviews** | Display `—`; Palate Sort sinks row |
| **Google-only listing** | Card shows `google_rating`; TP scores empty until reviews exist |
| **Palate filter + Google rows** | Google-only results suppressed in hybrid search when palate filter active |
| **Approved vs all reviews** | `rebuildRatingSummary` = approved only; `get-preference-stats` live path = all non-deleted top-level reviews |
| **Fuzzy vs exact matching** | Authentic rebuild = **fuzzy**; preference stats API = **exact** slug |
| **Web vs mobile** | Web v2 rebuild does **not** merge Google into Overall; web preference stats do **not** merge Google; web has no Shared 3-review threshold |
| **Legacy fallback** | `get-preference-stats` without `palates=` reads `restaurant_cuisine_rating_summary` by `palate_id` (precomputed, not live reviewer identity) |
| **Query caps** | Preference stats scan max 5,000 reviews; Google prior map max 5,000 cache rows per request |

---

## 11. When scores update — and rebuild automation

### Trigger table

| Event | Action |
|-------|--------|
| Review created | Async `scheduleRatingSummaryRebuild(restaurant_uuid)` |
| Review updated | Same |
| Review deleted | Same |
| Restaurant created | Rebuild scheduled |
| Admin bulk fix | `POST admin/backfill-rating-summary` with `x-admin-secret` |

Preference stats (`get-preference-stats`) are **computed live** on each request — no separate cache table for Search/Shared.

### How rebuilds actually fire today

All summary rebuilds — Overall/Authentic (`rebuildRatingSummary`), external review aggregates (`rebuildExternalReviewSummary`), and (proposed) palate ratings (`rebuildPalateRatingSummary`) — are triggered **synchronously in-process**, from inside the HTTP handler that performed the write:

```typescript
// e.g. restaurant-reviews/create-review.ts
await insertReview(...)
scheduleRatingSummaryRebuild(restaurantUuid) // fire-and-forget, not a queue
```

There is **no Hasura Event Trigger and no cron function in this repo.** This means: any write that does *not* go through one of these Nhost Function handlers never triggers a rebuild. Known blind spots today:

- Apify ingest scripts that insert `restaurant_external_reviews` rows directly
- Manual edits via the Hasura console
- Any future batch/admin tooling that writes to `restaurant_reviews` or `user_profiles` without calling the corresponding Nhost Function

Summaries in these cases go stale until someone remembers to run the relevant `admin/backfill-*` endpoint by hand.

### Phased plan

| Phase | Mechanism | When |
|-------|-----------|------|
| **A (current)** | In-handler `schedule*Rebuild()`, fire-and-forget | Now — fine at current write volume |
| **B** | Hasura Event Triggers on `restaurant_reviews`, `restaurant_external_reviews`, `user_profiles` → dedicated Nhost Function webhook | When ingest paths multiply (Apify, admin scripts, direct SQL) and blind spots above start causing visible staleness |
| **C** | Scheduled/cron Nhost Function — nightly full rebuild across all restaurants | Once Phase B exists, as a drift-correction safety net, not a replacement for it |

**Why Phase B, not just "add more `schedule*Rebuild()` calls":** every new write path is another call site someone has to remember to add. An Event Trigger fires on the row change itself, independent of which code path produced it — it closes the blind spot structurally instead of by convention.

**Why Phase C in addition to B, not instead of it:** the rebuild algorithm is a full table scan per restaurant, not an incremental delta. Event triggers fire per write and are cheap individually, but they can't catch a trigger that itself failed to fire (a webhook timeout, a Hasura metadata gap after a schema change). A nightly full rebuild is a low-cost correctness backstop — same reasoning as `admin/backfill-rating-summary`, just on a schedule instead of manually invoked.

**Not proposed:** moving rebuilds to a message queue (SQS/etc.) or a separate worker service. That would be new infrastructure beyond what Nhost provides natively (Event Triggers + scheduled functions cover both async decoupling and periodic reconciliation), and it doesn't match the "stay close to existing patterns" convention already established in this codebase.

This same Phase A/B/C plan applies to the proposed palate rating rebuilds — see [precompute-ratings-v2.md](./precompute-ratings-v2.md) §14, including the open question (its §9.6) on whether palate ratings should skip straight to Phase B given they have more write paths from day one than Overall/Authentic did.

---

## 12. API quick reference

| Need | Endpoint |
|------|----------|
| Overall + Authentic (one restaurant) | `GET restaurants-v2/get-rating-summary?restaurant_uuid=` |
| Search / Your / Shared (many restaurants) | `GET restaurants-v2/get-preference-stats?palates=slug1,slug2` |
| Authentic map (Smart Sort data) | `GET restaurants-v2/get-authentic-stats` |
| Browse list + filters | `GET restaurants-v2/get-restaurants?order_by=smart` |

### `get-rating-summary` response (simplified)

```json
{
  "ok": true,
  "data": {
    "overall_rating_avg": 4.5,
    "overall_rating_weighted": 4.12,
    "overall_review_count": 1003,
    "authentic_rating_avg": 4.7,
    "authentic_rating_weighted": 4.35,
    "authentic_review_count": 12
  }
}
```

### `get-preference-stats` response (simplified)

```json
{
  "ok": true,
  "data": {
    "stats": {
      "<restaurant_uuid>": { "avg": 4.6, "count": 8 }
    }
  }
}
```

---

## 13. Source code map

| File | Responsibility |
|------|----------------|
| `functions/_lib/rebuildRatingSummary.ts` | Overall + Authentic precompute; upsert summary tables |
| `functions/_lib/preference-stats-aggregate.ts` | Live Search/Shared aggregation |
| `functions/_lib/googleRatingPrior.ts` | Google normalize + bucket merge |
| `functions/_lib/palateUtils.ts` | `hasMatchingPalates`, `normalizePalates` |
| `functions/restaurants-v2/get-rating-summary.ts` | Rating summary HTTP handler |
| `functions/restaurants-v2/get-preference-stats.ts` | Preference stats HTTP handler |
| `functions/restaurants-v2/get-restaurants.ts` | Browse + Smart Sort |
| `tastyplates-mobile/hooks/useRestaurantScores.ts` | Detail screen orchestration |
| `tastyplates-mobile/lib/cuisineTaxonomy.ts` | Trust set for Your Score |
| `tastyplates-mobile/lib/sortByPalateMatch.ts` | Palate Sort comparator |
| `functions/_lib/rebuildPalateRatingSummary.ts` | *(proposed)* Palate-identity precompute — see [precompute-ratings-v2.md](./precompute-ratings-v2.md) §11 |

---

## 14. FAQ (human English)

**Q: Why do I see four numbers on one restaurant?**
A: Each number asks a different question. Overall is everyone; Authentic is cuisine insiders; Your Score is people like you in a broader cultural neighborhood; Shared is people with your exact palate.

**Q: Why is Shared Score locked?**
A: We need at least 3 reviews from matching palates so one person's opinion doesn't look like a community consensus.

**Q: Why does Overall differ from Google Maps?**
A: Overall blends TastyPlates reviews with Google's aggregate when the listing is linked. It is not a copy of Google's number.

**Q: Why is Smart Sort different from Highest Rated?**
A: Highest Rated uses overall stars. Smart Sort uses Authentic score (smoothed) — better for finding great cuisine-specific spots even if they are not the most reviewed.

**Q: What palates does the system use for me?**
A: Your profile palates from onboarding / Edit Profile. Review snapshots are only a fallback when profile data is missing.

**Q: Does leaving a review change all four scores?**
A: It always affects Overall (once approved). It affects Authentic if your palate matches the restaurant. It affects Search/Your/Shared if your palate matches the requested slug sets for those endpoints.

**Q: Is there a way to see ratings by ethnic palate identity, not just cuisine tags?**
A: Not yet — proposed in [precompute-ratings-v2.md](./precompute-ratings-v2.md), currently unimplemented.

---

## 15. Visibility matrix (mobile detail panel)

| Score | Guest | Signed in, no cuisine filter | Signed in + cuisine filter | Signed in + ≥3 shared reviews |
|-------|-------|------------------------------|----------------------------|-------------------------------|
| Overall | ✅ | ✅ | ✅ | ✅ |
| Authentic | ✅ | ✅ | ✅ | ✅ |
| Search | 🔒 | 🔒 | ✅ (or Your Score) | ✅ |
| Shared | 🔒 | 🔒 | 🔒* | ✅ |

\*Shared requires sign-in and sufficient matching review count; cuisine filter alone does not unlock Shared.
# articlesv2.md — Article Detail & Associated Restaurant Recovery

> **Purpose:** This document is a deep-dive recovery plan for the article detail screen and specifically how associated restaurants are resolved, fetched, displayed, and navigated inside an article. It covers the full data pipeline from Hasura through the transformer to the UI, and provides the complete mobile equivalent of every piece. This extends `recommend-articles.md` with full fidelity to the actual backend logic.

---

## 1. The Problem This Solves

The article detail page has a two-step fetch problem that does not exist in a simple GraphQL query:

**Step 1 — Fetch the article:**
`GET_ARTICLE_BY_SLUG_DETAIL` returns the article with `article_restaurant_associations[]`, but each association only contains `{ id, article_id, restaurant_id, display_order }` — **no restaurant data**. Hasura does not have a `restaurant` object relationship configured on this table.

**Step 2 — Enrich with restaurant data:**
Because the relationship is missing, `fetchArticleBySlug.ts` performs a second query — `GET_RESTAURANTS_BY_IDS` — passing the extracted `restaurant_id` integers as a batch. The results are then manually merged back onto each association before the transformer runs.

Without understanding this two-step pattern, the mobile implementation would produce articles with associated restaurant cards that show only placeholder images and no names.

```
fetchArticleBySlug(slug)
  │
  ├─ Step 1: GET_ARTICLE_BY_SLUG_DETAIL ($slug)
  │    └─ Returns: article + article_restaurant_associations[]
  │         (each assoc has restaurant_id but NO restaurant object)
  │
  ├─ enrichArticleRestaurantAssociations(row)
  │    ├─ Extract all restaurant_id integers from associations
  │    ├─ Step 2: GET_RESTAURANTS_BY_IDS ($ids: [Int!]!)
  │    │    └─ Returns: { id, uuid, title, slug, featured_image_url,
  │    │                  address, listing_street, content }
  │    └─ Merge: attach matching restaurant object onto each association
  │         { ...assoc, restaurant: restaurantRow }
  │
  └─ transformHasuraArticle(enrichedRow)
       └─ mapLinkedRestaurants(article_restaurant_associations)
            └─ For each assoc (now with .restaurant):
                 - title from restaurant.title
                 - slug from restaurant.slug
                 - imageUrl from restaurant.featured_image_url
                 - addressLine from restaurant.address || restaurant.listing_street
                 - description: stripHtml(restaurant.content) → truncate(220 chars)
                 → ArticleLinkedRestaurant[]
```

### Shipped in `tastyplates-mobile` (Expo)

The article detail route renders **`ArticleRelatedRestaurantsSection`** (`components/articles/ArticleRelatedRestaurantsSection.tsx`) under the HTML body: **one column** of cards per **§6** (16:9 image, title, description excerpt from `restaurant.content`, address, **View restaurant →**). Visual tokens follow **`documentation/design_system.md`** via `constants/brand` (`TEXT_HEADING`, `TEXT_BODY`, `TEXT_MUTED`, `BRAND_PRIMARY`, `BORDER_SUBTLE`). Nhost `articles/get-article-by-*` handlers batch-load restaurants (including **`content`**) and merge into associations. If associations exist but no card rows resolve (**§5 State B**), users see *This article covers N places* and **Explore restaurants →** (Restaurants tab).

*Terminology: this is the **associated restaurants** block. A future “related articles” rail would need new backend relations.*

### API contract (Nhost Functions)

Successful **`articles/get-article-by-slug`** and **`articles/get-article-by-id`** return:

- **`data.article`** — full row; **`article_restaurant_associations`** entries include **`restaurant`** after batch merge when enrichment succeeds (fields: `id`, `title`, `slug`, `featured_image_url`, `listing_street`, `address`, `average_rating`, `ratings_count`, **`content`**).
- **`data.articleMeta.restaurantEnrichment`** — `skipped` \| `ok` \| `partial` \| `failed` (see `documentation/api-guide.md` §8.8).

**Slug handler:** detail query first; on GraphQL **error** (not empty row), retries **simple** query without associations. **ILIKE** slug variants run only for slugs without `_` or `%` (wildcards). **By id:** only **`status: published`** and **`deleted_at` null** — aligns public mobile/web with slug behaviour.

---

## 2. Web Architecture — The Full Data Pipeline

### 2.1 Entry: `fetchArticleBySlug.ts`

```ts
// lib/articles/fetchArticleBySlug.ts

export async function fetchArticleBySlug(rawInput: string): Promise<ArticleRow | null> {
  const slug = normalizeArticleSlugParam(rawInput);

  // Attempt 1: exact match (normalized slug)
  let row = await fetchWithDetailThenSimple(slug, false);
  if (row) return enrichArticleRestaurantAssociations(row);

  // Attempt 2: exact match (raw trimmed slug — catches accidental double-encoding)
  const trimmedRaw = rawInput.trim();
  if (trimmedRaw && trimmedRaw !== slug) {
    row = await fetchWithDetailThenSimple(trimmedRaw, false);
    if (row) return enrichArticleRestaurantAssociations(row);
  }

  // Attempt 3: case-insensitive (_ilike) — only for slugs without _ or %
  if (isSafeForIlikeExactSlug(slug)) {
    row = await fetchWithDetailThenSimple(slug, true);
    if (row) return enrichArticleRestaurantAssociations(row);
  }

  return null;
}
```

**`normalizeArticleSlugParam`** decodes URL-encoded slugs up to 3 times until stable. This handles slugs that arrive double-encoded from email links or redirects.

**`fetchWithDetailThenSimple`** tries the full detail query first (`GET_ARTICLE_BY_SLUG_DETAIL`), and if Hasura returns an error (e.g. a relationship column doesn't exist in the schema yet), it falls back to `GET_ARTICLE_BY_SLUG_SIMPLE` which omits `author_profile` and `article_restaurant_*` associations.

### 2.2 Step 1: `GET_ARTICLE_BY_SLUG_DETAIL` — what it returns

```graphql
query GetArticleBySlugDetail($slug: String!) {
  articles(
    where: {
      slug: { _eq: $slug }
      deleted_at: { _is_null: true }
      status: { _eq: "published" }
    }
    limit: 1
  ) {
    id uuid slug title excerpt content category
    featured_image_url featured_image_alt
    reading_time_minutes published_at updated_at
    meta_title meta_description meta_keywords
    view_count gallery_images

    author_profile {
      id displayName avatarUrl email createdAt
    }

    # Location associations — for city/country context in meta row
    article_restaurant_location_associations(order_by: { display_order: asc }) {
      id display_order location_id
      restaurant_location {
        id name slug short_label flag_url type
      }
    }

    # Restaurant associations — ONLY IDs at this stage, NO restaurant object
    article_restaurant_associations(order_by: { display_order: asc }) {
      id article_id created_at display_order
      restaurant_id                 # ← integer FK, no nested restaurant yet
    }
  }
}
```

### 2.3 Step 2: `GET_RESTAURANTS_BY_IDS` — the enrichment query

```graphql
query GetRestaurantsByIds($ids: [Int!]!) {
  restaurants(where: { id: { _in: $ids } }) {
    id
    uuid
    title
    slug
    featured_image_url
    address          # raw address string or JSONB
    listing_street   # plain text fallback address
    content          # HTML — stripped and truncated to 220 chars for description
  }
}
```

**`enrichArticleRestaurantAssociations`:**
```ts
async function enrichArticleRestaurantAssociations(row: ArticleRow): Promise<ArticleRow> {
  const assocs = row.article_restaurant_associations;
  if (!Array.isArray(assocs) || assocs.length === 0) return row;

  // 1. Extract unique integer IDs from all associations
  const ids = [...new Set(
    assocs
      .map(a => parseRestaurantIntId(a.restaurant_id))
      .filter((n): n is number => n != null)
  )];
  if (ids.length === 0) return row;

  // 2. Batch fetch all restaurant rows in one query
  const result = await hasuraQuery<{ restaurants?: Record<string, unknown>[] }>(
    GET_RESTAURANTS_BY_IDS, { ids }
  );

  // 3. Build a Map for O(1) lookup by integer ID
  const byId = new Map<number, Record<string, unknown>>();
  for (const r of result.data?.restaurants ?? []) {
    const pk = parseRestaurantIntId(r.id);
    if (pk != null) byId.set(pk, r);
  }

  // 4. Merge: attach restaurant object onto each association
  const merged = assocs.map(a => {
    const rid = parseRestaurantIntId(a.restaurant_id);
    const restaurant = rid != null ? byId.get(rid) : undefined;
    if (!restaurant) return a;       // association remains without restaurant if not found
    return { ...a, restaurant };     // ← now has .restaurant for the transformer
  });

  return { ...row, article_restaurant_associations: merged };
}
```

### 2.4 The transformer: `mapLinkedRestaurants`

```ts
// utils/articleTransformers.ts

function mapLinkedRestaurants(raw: unknown): ArticleLinkedRestaurant[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ArticleLinkedRestaurant[] = [];

  for (const row of raw) {
    const o = row as Record<string, unknown>;
    const rest = o.restaurant as Record<string, unknown> | null;

    // Skip associations where restaurant data could not be loaded
    if (!rest) continue;

    const title = (rest.title as string)?.trim() || 'Restaurant';
    const slug = typeof rest.slug === 'string' ? rest.slug : undefined;

    // Description: strip HTML from restaurant.content, truncate to 220 chars
    const contentHtml = typeof rest.content === 'string' ? rest.content : '';
    const description = contentHtml
      ? truncatePlainText(stripHtmlServer(contentHtml), 220)
      : '';

    // Address: prefer raw address string, fallback to listing_street
    const address =
      (typeof rest.address === 'string' && rest.address.trim()) ||
      (typeof rest.listing_street === 'string' && rest.listing_street.trim()) ||
      '';

    out.push({
      associationId: o.id != null ? String(o.id) : '',
      display_order: typeof o.display_order === 'number' ? o.display_order : undefined,
      restaurant_id: o.restaurant_id != null ? String(o.restaurant_id) : undefined,
      title,
      slug,
      uuid: rest.uuid != null ? String(rest.uuid) : undefined,
      imageUrl: typeof rest.featured_image_url === 'string'
        ? rest.featured_image_url : undefined,
      addressLine: address || undefined,
      description: description || undefined,
    });
  }

  return out.length ? out : undefined;
}
```

**Result shape — `ArticleLinkedRestaurant`:**
```ts
interface ArticleLinkedRestaurant {
  associationId: string;    // association table row ID (for React keys)
  display_order?: number;   // used by sortedRestaurants() before rendering
  restaurant_id?: string;   // integer FK as string
  title: string;            // from restaurant.title
  slug?: string;            // from restaurant.slug — used to build href
  uuid?: string;            // from restaurant.uuid
  imageUrl?: string;        // from restaurant.featured_image_url
  addressLine?: string;     // from restaurant.address || restaurant.listing_street
  description?: string;     // from restaurant.content → strip HTML → truncate 220
}
```

### 2.5 Two fallback states in `ArticleDetail.tsx`

```tsx
// After transformation, ArticleDetail checks which state to render:

const linkedRestaurants = article.article_linked_restaurants ?? [];
const associationCount  = article.article_restaurant_associations?.length ?? 0;

// State A: enrichment succeeded — full restaurant cards
const hasRestaurants = linkedRestaurants.length > 0;

// State B: associations exist but restaurant data couldn't be loaded
//          (enrichment query failed or restaurant rows not found)
const hasAssociationIdsOnly = linkedRestaurants.length === 0 && associationCount > 0;

// Render:
{hasRestaurants && (
  <ArticleRelatedRestaurantsSection restaurants={linkedRestaurants} />
)}

{hasAssociationIdsOnly && (
  // Graceful fallback — "This article covers N places on TastyPlates"
  // + "Explore restaurants →" link
)}
```

### 2.6 `ArticleRelatedRestaurantsSection` — web render spec

```tsx
// Full render from the source:

<section className="mt-10 pt-8 border-t border-gray-100 font-neusans">
  <h2 className="text-lg md:text-xl font-semibold text-gray-900 mb-2 text-center">
    Restaurants in this article
  </h2>
  <p className="text-sm text-gray-600 mb-6 text-center">
    Places we mention in this story — tap through for full listings, photos, and reviews.
  </p>

  <ul className="flex flex-col gap-4 md:gap-5">
    {sortedRestaurants(restaurants).map(r => {
      const href = r.slug ? `/restaurants/${encodeURIComponent(r.slug)}` : null;
      const img  = r.imageUrl?.trim() || DEFAULT_RESTAURANT_IMAGE;

      return (
        <li key={r.associationId}>
          <Link href={href} ...> {/* or plain div if no href */}
            <div className="flex flex-col gap-4 p-4 rounded-2xl bg-white
                            border border-gray-100 hover:border-[#ff7c0a]/30 transition-colors">
              {/* Restaurant image — 16:9 */}
              <div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden bg-gray-100">
                <Image src={img} alt={r.title} fill className="object-cover" />
              </div>

              {/* Restaurant info */}
              <div className="min-w-0 flex-1 flex flex-col justify-center">
                <h3 className="text-lg font-semibold text-gray-900 mb-1">{r.title}</h3>
                {r.description && (
                  <p className="text-sm text-gray-600 leading-relaxed mb-2 line-clamp-3">
                    {r.description}
                  </p>
                )}
                {r.addressLine && (
                  <p className="text-xs text-gray-500 mt-auto">{r.addressLine}</p>
                )}
                {href && (
                  <span className="inline-flex mt-3 text-sm font-medium text-[#ff7c0a]">
                    View restaurant →
                  </span>
                )}
              </div>
            </div>
          </Link>
        </li>
      );
    })}
  </ul>
</section>
```

---

## 3. Type Definitions (port directly)

```ts
// types/article.ts — port unchanged

export interface ArticleAuthorProfile {
  id?: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
  createdAt?: string;
}

export interface ArticleRestaurantAssociation {
  id: string;
  article_id?: string;
  created_at?: string;
  display_order?: number;
  restaurant_id?: string;   // integer FK stored as string after transformation
}

export interface ArticleLinkedLocation {
  id: string;
  display_order?: number;
  location_id?: string;
  name: string;              // city or country name shown in meta row
  slug?: string;
  short_label?: string;
  flag_url?: string;
  type?: string;             // 'city' | 'country' — drives cityLocation selection
}

export interface ArticleLinkedRestaurant {
  associationId: string;    // React key
  display_order?: number;   // sort field
  restaurant_id?: string;
  title: string;
  slug?: string;            // used to build /restaurants/[slug] href
  uuid?: string;
  imageUrl?: string;        // restaurant.featured_image_url
  addressLine?: string;     // restaurant.address || restaurant.listing_street
  description?: string;     // restaurant.content → stripped → truncated 220
}

export interface Article {
  id: string;
  uuid?: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  cover_image_url: string;
  featured_image_url?: string;
  featured_image_alt?: string;
  reading_time_minutes: number;
  published_at: string;
  updated_at?: string;
  content?: string;
  author_id?: string;
  author_name?: string;
  author_profile?: ArticleAuthorProfile | null;
  meta_title?: string;
  meta_description?: string;
  meta_keywords?: string;
  view_count?: number;
  gallery_images?: unknown[];
  // Raw associations (IDs only — used for hasAssociationIdsOnly fallback count)
  article_restaurant_associations?: ArticleRestaurantAssociation[];
  // Resolved after enrichment + transformation:
  article_linked_locations?: ArticleLinkedLocation[];
  article_linked_restaurants?: ArticleLinkedRestaurant[];
}
```

---

## 4. Mobile Data Fetching — The Two-Query Pattern

In the mobile app there is no BFF layer, so both queries go through Apollo Client directly. The enrichment logic that lives in `fetchArticleBySlug.ts` must be ported to the mobile service layer.

### 4.1 GraphQL queries (mobile — `graphql/queries/articleQueries.ts`)

```ts
import { gql } from '@apollo/client';

// Step 1: article detail with associations (IDs only — no restaurant object yet)
export const GET_ARTICLE_BY_SLUG_DETAIL = gql`
  query GetArticleBySlugDetail($slug: String!) {
    articles(
      where: {
        slug: { _eq: $slug }
        deleted_at: { _is_null: true }
        status: { _eq: "published" }
      }
      limit: 1
    ) {
      id uuid slug title excerpt content category
      featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at
      meta_title meta_description meta_keywords
      view_count gallery_images

      author_profile {
        id displayName avatarUrl email createdAt
      }

      article_restaurant_location_associations(order_by: { display_order: asc }) {
        id display_order location_id
        restaurant_location {
          id name slug short_label flag_url type
        }
      }

      article_restaurant_associations(order_by: { display_order: asc }) {
        id article_id created_at display_order
        restaurant_id
        # NOTE: no restaurant {} block here — Hasura has no relationship configured
      }
    }
  }
`;

// ILIKE fallback for case-insensitive slug matching
export const GET_ARTICLE_BY_SLUG_DETAIL_ILIKE = gql`
  query GetArticleBySlugDetailIlike($slug: String!) {
    articles(
      where: {
        slug: { _ilike: $slug }
        deleted_at: { _is_null: true }
        status: { _eq: "published" }
      }
      limit: 1
    ) {
      id uuid slug title excerpt content category
      featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at
      meta_title meta_description meta_keywords
      view_count gallery_images
      author_profile { id displayName avatarUrl email createdAt }
      article_restaurant_location_associations(order_by: { display_order: asc }) {
        id display_order location_id
        restaurant_location { id name slug short_label flag_url type }
      }
      article_restaurant_associations(order_by: { display_order: asc }) {
        id article_id created_at display_order restaurant_id
      }
    }
  }
`;

// Simple fallback — omits relationships in case schema differs
export const GET_ARTICLE_BY_SLUG_SIMPLE = gql`
  query GetArticleBySlugSimple($slug: String!) {
    articles(
      where: {
        slug: { _eq: $slug }
        deleted_at: { _is_null: true }
        status: { _eq: "published" }
      }
      limit: 1
    ) {
      id uuid slug title excerpt content category
      featured_image_url featured_image_alt
      reading_time_minutes published_at updated_at
      meta_title meta_description meta_keywords
      view_count gallery_images
    }
  }
`;

// Step 2: batch fetch restaurants by integer IDs
export const GET_RESTAURANTS_BY_IDS = gql`
  query GetRestaurantsByIds($ids: [Int!]!) {
    restaurants(where: { id: { _in: $ids } }) {
      id
      uuid
      title
      slug
      featured_image_url
      address
      listing_street
      content
    }
  }
`;
```

### 4.2 Mobile service (`services/articleService.ts`)

```ts
// services/articleService.ts
import { apolloClient } from '@/lib/apollo';
import {
  GET_ARTICLE_BY_SLUG_DETAIL,
  GET_ARTICLE_BY_SLUG_DETAIL_ILIKE,
  GET_ARTICLE_BY_SLUG_SIMPLE,
  GET_RESTAURANTS_BY_IDS,
} from '@/graphql/queries/articleQueries';
import { transformHasuraArticle } from '@/utils/articleTransformers';
import type { Article } from '@/types/article';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Decode URL-encoded slug up to 3 times until stable */
export function normalizeArticleSlug(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  try {
    let prev = '';
    for (let i = 0; i < 3 && prev !== s; i++) {
      prev = s;
      s = decodeURIComponent(s);
    }
  } catch {
    // keep last good value
  }
  return s.trim();
}

/** _ilike treats _ and % as wildcards — skip CI fallback for those slugs */
function isSafeForIlike(slug: string): boolean {
  return slug.length > 0 && !slug.includes('%') && !slug.includes('_');
}

function parseRestaurantIntId(id: unknown): number | null {
  if (id == null) return null;
  if (typeof id === 'number' && Number.isFinite(id)) return Math.trunc(id);
  const n = parseInt(String(id), 10);
  return Number.isNaN(n) ? null : n;
}

// ── Step 1: Fetch article ─────────────────────────────────────────────────

async function fetchWithDetailThenSimple(
  slug: string,
  useIlike: boolean
): Promise<Record<string, unknown> | null> {
  const detailQuery = useIlike ? GET_ARTICLE_BY_SLUG_DETAIL_ILIKE : GET_ARTICLE_BY_SLUG_DETAIL;
  const simpleQuery = GET_ARTICLE_BY_SLUG_SIMPLE;

  // Try full detail query first
  try {
    const { data, errors } = await apolloClient.query({
      query: detailQuery,
      variables: { slug },
      fetchPolicy: 'network-only',
    });
    if (!errors?.length && data?.articles?.[0]) {
      return data.articles[0] as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[articleService] detail query failed, falling back to simple:', e);
  }

  // Fallback: simple query without relationships
  try {
    const { data, errors } = await apolloClient.query({
      query: simpleQuery,
      variables: { slug },
      fetchPolicy: 'network-only',
    });
    if (!errors?.length && data?.articles?.[0]) {
      return data.articles[0] as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[articleService] simple query also failed:', e);
  }

  return null;
}

// ── Step 2: Enrich with restaurant data ──────────────────────────────────

async function enrichAssociations(
  row: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const assocs = row.article_restaurant_associations;
  if (!Array.isArray(assocs) || assocs.length === 0) return row;

  // Extract unique integer restaurant IDs
  const ids = [
    ...new Set(
      assocs
        .map(a => parseRestaurantIntId((a as Record<string, unknown>).restaurant_id))
        .filter((n): n is number => n != null)
    ),
  ];
  if (ids.length === 0) return row;

  // Batch fetch restaurant rows
  let restaurantRows: Record<string, unknown>[] = [];
  try {
    const { data, errors } = await apolloClient.query({
      query: GET_RESTAURANTS_BY_IDS,
      variables: { ids },
      fetchPolicy: 'cache-first',  // restaurants change infrequently — safe to cache
    });
    if (!errors?.length) {
      restaurantRows = (data?.restaurants ?? []) as Record<string, unknown>[];
    }
  } catch (e) {
    console.warn('[articleService] GET_RESTAURANTS_BY_IDS failed:', e);
    // Return row without enrichment — transformer will skip associations gracefully
    return row;
  }

  // Build O(1) lookup by integer ID
  const byId = new Map<number, Record<string, unknown>>();
  for (const r of restaurantRows) {
    const pk = parseRestaurantIntId(r.id);
    if (pk != null) byId.set(pk, r);
  }

  // Merge restaurant object onto each association
  const enriched = assocs.map(a => {
    const o = a as Record<string, unknown>;
    const rid = parseRestaurantIntId(o.restaurant_id);
    const restaurant = rid != null ? byId.get(rid) : undefined;
    if (!restaurant) return o;
    return { ...o, restaurant };
  });

  return { ...row, article_restaurant_associations: enriched };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch a single published article by slug.
 * Mirrors the web's fetchArticleBySlug.ts exactly:
 *   1. Attempt exact normalized slug
 *   2. Attempt raw trimmed slug (handles double-encoding edge cases)
 *   3. Attempt case-insensitive (_ilike) if slug has no wildcards
 * Each attempt runs detail → simple fallback, then enriches with restaurant data.
 */
export async function fetchArticleBySlug(rawInput: string): Promise<Article | null> {
  const slug = normalizeArticleSlug(rawInput);

  // Attempt 1: exact normalized
  let row = await fetchWithDetailThenSimple(slug, false);
  if (row) {
    row = await enrichAssociations(row);
    return transformHasuraArticle(row);
  }

  // Attempt 2: raw trimmed (catches double-encoding)
  const trimmedRaw = rawInput.trim();
  if (trimmedRaw && trimmedRaw !== slug) {
    row = await fetchWithDetailThenSimple(trimmedRaw, false);
    if (row) {
      row = await enrichAssociations(row);
      return transformHasuraArticle(row);
    }
  }

  // Attempt 3: case-insensitive ILIKE
  if (isSafeForIlike(slug)) {
    row = await fetchWithDetailThenSimple(slug, true);
    if (row) {
      row = await enrichAssociations(row);
      return transformHasuraArticle(row);
    }
  }

  return null;
}
```

### 4.3 Transformer — port directly (`utils/articleTransformers.ts`)

Port `articleTransformers.ts` and `stripHtmlServer.ts` verbatim — they are pure functions with no web/Node.js dependencies. The only import to update is the source path.

```ts
// utils/stripHtml.ts (renamed from lib/stripHtmlServer.ts — no "Server" in RN context)

export function stripHtml(html: string): string {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncatePlainText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trimEnd()}…`;
}
```

```ts
// utils/articleTransformers.ts — port verbatim, update import:
import { stripHtml, truncatePlainText } from '@/utils/stripHtml';
// (instead of: import { stripHtmlServer, truncatePlainText } from '@/lib/stripHtmlServer')
// Replace all stripHtmlServer( calls with stripHtml(
```

---

## 5. Mobile Screen — Article Detail with Associated Restaurants

### 5.1 Screen layout

```
/articles/[slug]

┌─────────────────────────────────────────┐
│  Hero image (16:9, full bleed)          │
│─────────────────────────────────────────│
│  px-4 pt-6:                             │
│  FOOD GUIDE                  (category) │
│  Article title                (h1, 2xl) │
│                                         │
│  📍 Hong Kong · 🕐 5 min read          │
│  · 12 Jan 2025 · 👤 Author Name        │
│  · 👁 1,234                            │
│─────────────────────────────────────────│
│  │ Excerpt text (italic, orange border) │
│─────────────────────────────────────────│
│  Body content (text, 15px, gray-700)   │
│─────────────────────────────────────────│
│  ── Restaurants in this article ────── │
│  [16:9 image]                           │
│  Restaurant Name                        │
│  Description (3 lines max)              │
│  123 Street, City               (addr)  │
│  View restaurant →              (#ff7c0a)│
│                                         │
│  [next restaurant card]                 │
│  ...                                    │
│─────────────────────────────────────────│
│  [Fallback: "This article covers N      │
│   places · Explore restaurants →"]      │
└─────────────────────────────────────────┘
```

### 5.2 Article detail screen (`/articles/[slug].tsx`)

```tsx
// app/articles/[slug].tsx

export default function ArticleDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const { trigger: haptic } = useHaptic();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);

    fetchArticleBySlug(slug ?? '').then(result => {
      if (cancelled) return;
      if (result) {
        setArticle(result);
      } else {
        setNotFound(true);
      }
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setNotFound(true); setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [slug]);

  if (loading) return <ArticleDetailSkeleton />;
  if (notFound || !article) return <ArticleNotFoundScreen />;

  // Derive display values — same logic as web ArticleDetail.tsx
  const heroSrc = article.cover_image_url?.trim() || DEFAULT_ARTICLE_COVER_IMAGE;
  const authorLabel = article.author_profile?.displayName || article.author_name;
  const formattedDate = article.published_at
    ? new Date(article.published_at).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null;

  const linkedLocs = article.article_linked_locations ?? [];
  const linkedRestaurants = article.article_linked_restaurants ?? [];
  const associationCount = article.article_restaurant_associations?.length ?? 0;
  const cityLocation = linkedLocs.find(l => l.type === 'city') ?? linkedLocs[0];
  const hasRestaurants = linkedRestaurants.length > 0;
  const hasAssociationIdsOnly = linkedRestaurants.length === 0 && associationCount > 0;

  return (
    <ScrollView
      className="flex-1 bg-white"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 48 }}
    >
      {/* ── Hero image (full-bleed, 16:9) ── */}
      <View style={{ width: SCREEN_WIDTH, aspectRatio: 16 / 9 }}>
        <Image
          source={{ uri: heroSrc }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
        />
      </View>

      {/* ── Content ── */}
      <View className="px-4 pt-6">

        {/* Category label */}
        {article.category ? (
          <Text
            className="font-neusans font-semibold uppercase mb-1"
            style={{ fontSize: 11, letterSpacing: 0.8, color: '#ff7c0a' }}
          >
            {article.category}
          </Text>
        ) : null}

        {/* Title */}
        <Text
          className="font-neusans font-semibold text-[#1b1b1b] leading-snug mb-3"
          style={{ fontSize: 22 }}
        >
          {article.title}
        </Text>

        {/* ── Meta row ── */}
        <View className="flex-row flex-wrap items-center mb-6" style={{ gap: 8 }}>
          {cityLocation?.name && (
            <>
              <View className="flex-row items-center gap-1">
                <FiMapPin size={12} color="#9ca3af" />
                <Text className="font-neusans text-xs text-gray-400">
                  {cityLocation.name}
                </Text>
              </View>
              <Text className="font-neusans text-xs text-gray-400">·</Text>
            </>
          )}
          <View className="flex-row items-center gap-1">
            <FiClock size={12} color="#9ca3af" />
            <Text className="font-neusans text-xs text-gray-400">
              {article.reading_time_minutes} min read
            </Text>
          </View>
          {formattedDate && (
            <>
              <Text className="font-neusans text-xs text-gray-400">·</Text>
              <Text className="font-neusans text-xs text-gray-400">{formattedDate}</Text>
            </>
          )}
          {authorLabel && (
            <>
              <Text className="font-neusans text-xs text-gray-400">·</Text>
              <View className="flex-row items-center gap-1.5">
                {article.author_profile?.avatarUrl && (
                  <Image
                    source={{ uri: article.author_profile.avatarUrl }}
                    style={{ width: 16, height: 16, borderRadius: 8 }}
                    contentFit="cover"
                  />
                )}
                <Text className="font-neusans text-xs text-gray-400">{authorLabel}</Text>
              </View>
            </>
          )}
          {typeof article.view_count === 'number' && article.view_count > 0 && (
            <>
              <Text className="font-neusans text-xs text-gray-400">·</Text>
              <View className="flex-row items-center gap-1">
                <FiEye size={12} color="#9ca3af" />
                <Text className="font-neusans text-xs text-gray-400">
                  {article.view_count.toLocaleString()}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* ── Excerpt — italic, orange left border ── */}
        {article.excerpt ? (
          <View
            className="mb-6"
            style={{ borderLeftWidth: 2, borderLeftColor: '#ff7c0a', paddingLeft: 16 }}
          >
            <Text
              className="font-neusans text-base text-gray-500 leading-relaxed"
              style={{ fontStyle: 'italic' }}
            >
              {article.excerpt}
            </Text>
          </View>
        ) : null}

        {/* ── Body content ── */}
        {article.content ? (
          <Text
            className="font-neusans leading-relaxed text-gray-700"
            style={{ fontSize: 15 }}
          >
            {article.content}
          </Text>
        ) : null}

        {/* ── State A: Related restaurants (enrichment succeeded) ── */}
        {hasRestaurants && (
          <ArticleRelatedRestaurantsSection restaurants={linkedRestaurants} />
        )}

        {/* ── State B: Fallback (associations exist but restaurant data unavailable) ── */}
        {hasAssociationIdsOnly && (
          <View
            className="mt-10 pt-8"
            style={{ borderTopWidth: 1, borderTopColor: '#f3f4f6' }}
          >
            <Text className="font-neusans font-semibold text-lg text-gray-900 mb-2">
              Restaurants in this story
            </Text>
            <Text className="font-neusans text-sm text-gray-600 mb-3">
              This article covers {associationCount}{' '}
              {associationCount === 1 ? 'place' : 'places'} on TastyPlates.
            </Text>
            <Pressable onPress={() => { haptic('light'); router.push('/restaurants'); }}>
              <Text className="font-neusans text-sm font-medium text-[#ff7c0a]">
                Explore restaurants →
              </Text>
            </Pressable>
          </View>
        )}

      </View>
    </ScrollView>
  );
}
```

---

## 6. `ArticleRelatedRestaurantsSection` — Mobile Component

### Full component (exact visual recovery)

```tsx
// components/articles/ArticleRelatedRestaurantsSection.tsx

function sortedRestaurants(list: ArticleLinkedRestaurant[]): ArticleLinkedRestaurant[] {
  return [...list].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
}

export const ArticleRelatedRestaurantsSection = ({
  restaurants,
}: {
  restaurants: ArticleLinkedRestaurant[];
}) => {
  const { trigger: haptic } = useHaptic();
  if (!restaurants.length) return null;

  const rows = sortedRestaurants(restaurants);

  return (
    <View
      className="mt-10 pt-8 font-neusans"
      style={{ borderTopWidth: 1, borderTopColor: '#f3f4f6' }}
    >
      {/* Section heading */}
      <Text
        className="font-neusans font-semibold text-gray-900 mb-2 text-center"
        style={{ fontSize: 18 }}
      >
        Restaurants in this article
      </Text>
      <Text className="font-neusans text-sm text-gray-600 mb-6 text-center">
        Places we mention in this story — tap through for full listings, photos, and reviews.
      </Text>

      {/* Restaurant card list */}
      <View style={{ gap: 16 }}>
        {rows.map(r => {
          const href = r.slug
            ? `/restaurants/${encodeURIComponent(r.slug)}`
            : null;
          const imgUri = r.imageUrl?.trim() || DEFAULT_RESTAURANT_IMAGE;

          return (
            <Pressable
              key={r.associationId}
              onPress={href
                ? () => { haptic('light'); router.push(href); }
                : undefined
              }
              disabled={!href}
            >
              {/* Card: p-4, rounded-2xl, bg-white, border-gray-100 */}
              <View
                className="p-4 rounded-2xl bg-white"
                style={{ borderWidth: 1, borderColor: '#f3f4f6' }}
              >
                {/* Restaurant image — 16:9, rounded-xl */}
                <View
                  className="w-full rounded-xl overflow-hidden bg-gray-100 mb-4"
                  style={{ aspectRatio: 16 / 9 }}
                >
                  <Image
                    source={{ uri: imgUri }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                  />
                </View>

                {/* Info block */}
                <View className="flex-1 flex-col">

                  {/* Restaurant name */}
                  <Text
                    className="font-neusans font-semibold text-gray-900 mb-1"
                    style={{ fontSize: 18 }}
                  >
                    {r.title}
                  </Text>

                  {/* Description — 220-char truncated plain text from restaurant.content */}
                  {r.description ? (
                    <Text
                      className="font-neusans text-sm text-gray-600 leading-relaxed mb-2"
                      numberOfLines={3}
                    >
                      {r.description}
                    </Text>
                  ) : null}

                  {/* Address */}
                  {r.addressLine ? (
                    <Text className="font-neusans text-xs text-gray-500">
                      {r.addressLine}
                    </Text>
                  ) : null}

                  {/* CTA — only when slug is available */}
                  {href ? (
                    <Text
                      className="font-neusans text-sm font-medium mt-3"
                      style={{ color: '#ff7c0a' }}
                    >
                      View restaurant →
                    </Text>
                  ) : null}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};
```

---

## 7. Skeleton States

### Article detail skeleton

```tsx
// components/articles/ArticleDetailSkeleton.tsx
// Mirrors web ArticleDetailSkeleton exactly

const ArticleDetailSkeleton = () => (
  <View className="flex-1 bg-white">
    {/* Hero image */}
    <View
      className="w-full bg-gray-300 animate-pulse"
      style={{ aspectRatio: 16 / 9 }}
    />
    <View className="px-4 pt-6 animate-pulse">
      {/* Back link placeholder */}
      <View className="h-4 w-16 rounded bg-gray-200 mb-6" />
      {/* Category */}
      <View className="h-3 w-24 rounded bg-gray-200 mb-2" />
      {/* Title — 2 lines */}
      <View className="h-8 w-full rounded bg-gray-300 mb-1" />
      <View className="h-8 w-3/4 rounded bg-gray-300 mb-4" />
      {/* Meta row */}
      <View className="flex-row gap-2 mb-6">
        <View className="h-3 w-20 rounded bg-gray-200" />
        <View className="h-3 w-4 rounded bg-gray-200" />
        <View className="h-3 w-28 rounded bg-gray-200" />
      </View>
      {/* Body lines */}
      {[100, 83, 100, 80].map((pct, i) => (
        <View
          key={i}
          className="h-4 rounded bg-gray-200 mb-3"
          style={{ width: `${pct}%` }}
        />
      ))}
    </View>
  </View>
);
```

### Related restaurants section skeleton

Shown inside the article scroll while the restaurant enrichment step is in flight. Since enrichment happens in the same `fetchArticleBySlug` call before the article is set in state, the related restaurants section only needs a skeleton if you choose to lazy-load it separately. If you use the single-call approach (recommended), the whole detail screen shows `ArticleDetailSkeleton` until both steps complete.

If you do split the fetch (fetch article first, show partial content, then enrich separately), here is the section skeleton:

```tsx
const RelatedRestaurantsSkeleton = ({ count = 2 }: { count?: number }) => (
  <View className="mt-10 pt-8" style={{ borderTopWidth: 1, borderTopColor: '#f3f4f6' }}>
    {/* Heading */}
    <View className="h-6 w-48 rounded bg-gray-300 mx-auto mb-2 animate-pulse" />
    <View className="h-4 w-72 rounded bg-gray-200 mx-auto mb-6 animate-pulse" />
    {/* Cards */}
    <View style={{ gap: 16 }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} className="p-4 rounded-2xl bg-white animate-pulse"
              style={{ borderWidth: 1, borderColor: '#f3f4f6' }}>
          {/* 16:9 image */}
          <View className="w-full rounded-xl bg-gray-200 mb-4"
                style={{ aspectRatio: 16 / 9 }} />
          {/* Name */}
          <View className="h-6 w-2/3 rounded bg-gray-300 mb-2" />
          {/* Description — 3 lines */}
          <View className="h-4 w-full rounded bg-gray-200 mb-1" />
          <View className="h-4 w-11/12 rounded bg-gray-200 mb-1" />
          <View className="h-4 w-3/4 rounded bg-gray-200 mb-3" />
          {/* Address */}
          <View className="h-3 w-1/2 rounded bg-gray-200" />
        </View>
      ))}
    </View>
  </View>
);
```

---

## 8. Design Token Reference

All values extracted directly from the source code:

| Element | Value | Source |
|---------|-------|--------|
| Section separator | `borderTopWidth: 1, borderTopColor: '#f3f4f6'` | `border-t border-gray-100` |
| Section top spacing | `mt-10 pt-8` (40px top margin, 32px padding) | `_ArticleRelatedRestaurantsSection_` |
| Section heading | `font-neusans font-semibold text-gray-900 text-center` | `text-lg md:text-xl` → 18px mobile |
| Section subtext | `font-neusans text-sm text-gray-600 mb-6 text-center` | same source |
| Card container | `p-4 rounded-2xl bg-white border border-gray-100` | `p-4 rounded-2xl bg-white border border-gray-100` |
| Card hover border | `hover:border-[#ff7c0a]/30` → not applicable on native | focus ring instead |
| Restaurant image | `aspectRatio: 16/9`, `rounded-xl overflow-hidden bg-gray-100` | `aspect-[16/9] rounded-xl` |
| Restaurant name | `font-neusans font-semibold text-gray-900` 18px | `text-lg` |
| Description | `font-neusans text-sm text-gray-600 leading-relaxed` 3 lines | `line-clamp-3` |
| Address | `font-neusans text-xs text-gray-500` | `text-xs text-gray-500 mt-auto` |
| CTA | `font-neusans text-sm font-medium text-[#ff7c0a]` | `inline-flex mt-3` |
| CTA text | `"View restaurant →"` (exact string) | source |
| Gap between cards | 16px | `gap-4 md:gap-5` |
| Category label | `fontSize: 11, letterSpacing: 0.8, color: '#ff7c0a'` | `text-[11px] tracking-wider uppercase` |
| Excerpt border | `borderLeftWidth: 2, borderLeftColor: '#ff7c0a', paddingLeft: 16` | `border-l-2 border-[#ff7c0a] pl-4` |
| Excerpt text | `fontStyle: 'italic', text-base text-gray-500 leading-relaxed` | same |
| Body text | `fontSize: 15, text-gray-700 leading-relaxed` | `text-[15px] text-gray-700` |
| Fallback heading | `font-neusans font-semibold text-lg text-gray-900` | `text-lg font-semibold` |
| Fallback CTA | `font-neusans text-sm font-medium text-[#ff7c0a]` | `inline-flex text-sm font-medium` |

---

## 9. Edge Cases and Error Handling

### Slug resolution failures

| Case | What happens | Mobile handling |
|------|-------------|-----------------|
| Slug not found in DB | `fetchArticleBySlug` returns `null` | Show `ArticleNotFoundScreen` with back button |
| Slug double-encoded (e.g. from email link) | `normalizeArticleSlug` decodes up to 3× | Handled in service layer |
| Slug has uppercase letters | ILIKE fallback attempted if no `_` or `%` | Handled in service layer |
| Slug has `_` or `%` (ILIKE wildcards) | ILIKE fallback skipped | Returns null — show not-found |

### Restaurant enrichment failures

| Case | What happens | Mobile handling |
|------|-------------|-----------------|
| `GET_RESTAURANTS_BY_IDS` fails | Warning logged, `enrichAssociations` returns raw row | `mapLinkedRestaurants` skips assocs without `.restaurant` → `linkedRestaurants = []` → `hasAssociationIdsOnly` state shows fallback |
| Restaurant not found for a specific ID | That association's `restaurant` is `undefined` | Transformer skips that row — other restaurants still render |
| All restaurants missing | `linkedRestaurants = []`, `associationCount > 0` | Fallback: "This article covers N places · Explore restaurants →" |
| Article has no associations at all | `article_restaurant_associations = []` | Neither section renders — body ends after content |

### Content rendering

| Case | What happens |
|------|-------------|
| `article.content` is HTML | Web uses `prose` CSS class. Mobile renders as plain text — strip HTML before display if needed |
| `restaurant.content` is HTML | `stripHtml()` + `truncatePlainText(220)` runs in transformer — safe |
| `imageUrl` is empty/null | Falls back to `DEFAULT_RESTAURANT_IMAGE` constant |
| `r.slug` is undefined | `href = null` → card renders without Pressable, CTA not shown |

---

## 10. Component & File Checklist

| File | Source | Action |
|------|--------|--------|
| `types/article.ts` | `src/types/article.ts` | Port verbatim |
| `utils/stripHtml.ts` | `src/lib/stripHtmlServer.ts` | Port, rename function `stripHtmlServer` → `stripHtml` |
| `utils/articleTransformers.ts` | `src/utils/articleTransformers.ts` | Port, update `stripHtmlServer` import |
| `graphql/queries/articleQueries.ts` | `src/app/graphql/Articles/articleQueries.ts` | Port as Apollo `gql` tagged literals |
| `graphql/queries/restaurantQueries.ts` | Partial port of `src/app/graphql/Restaurants/restaurantQueries.ts` | Add `GET_RESTAURANTS_BY_IDS` |
| `services/articleService.ts` | `src/lib/articles/fetchArticleBySlug.ts` + `src/app/api/v1/articles/get-article-by-slug/route.ts` | New mobile service combining both |
| `components/articles/ArticleRelatedRestaurantsSection.tsx` | `src/components/Articles/ArticleRelatedRestaurantsSection.tsx` | Port to RN — spec in §6 |
| `components/articles/ArticleDetailSkeleton.tsx` | Inside `src/components/Articles/ArticleDetail.tsx` | Port to RN — spec in §7 |
| `app/articles/[slug].tsx` | No web page exists — proposed | New screen — spec in §5 |

---

## 11. Haptic Map

| Interaction | Preset |
|-------------|--------|
| Tap related restaurant card | `light` |
| Tap "View restaurant →" CTA | `light` |
| Tap "Explore restaurants →" (fallback) | `light` |
| Tap back navigation | *(native stack — no haptic needed)* |
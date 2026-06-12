# Tastyplates Nhost — API & Hasura (v2)

> **Superseded by [api-doc-v3.md](./api-doc-v3.md)** — v3 adds Nhost Storage uploads, `media_assets`, restaurant-lists Hasura notes, and upload troubleshooting. This file is kept for historical review-feed deploy context.

Combined reference for **Hasura metadata**, **deploy operations**, and how they connect to **Nhost Functions** and the mobile app.

| Doc | Scope |
|-----|--------|
| [api-guide.md](./api-guide.md) | HTTP functions: routes, auth, request/response envelope |
| **This doc (v2)** | Hasura layout, metadata deploy, troubleshooting, smoke tests |
| [nhost/migrations/README.md](../nhost/migrations/README.md) | SQL migrations policy |
| [final-deprecation-migration.md](./final-deprecation-migration.md) | FK retarget preflight (§E-2) |
| [decouple-plan.md](./decouple-plan.md) | Monorepo decouple context |

---

## Part 1 — Hasura metadata & migrations

This repo follows the [Nhost project layout](https://docs.nhost.io/platform/cli/local-development/):

```
config.yaml           # Hasura CLI root (committed — required for Nhost deploy metadata step)
config.yaml.example   # Local template (copy to config.yaml if needed)
nhost/
  nhost.toml
  metadata/          # Hasura API schema, permissions, relationships
  migrations/        # Postgres schema (can be empty default/ for metadata-only deploy)
  emails/
```

Metadata was synced from `Repo/metadata` in the monorepo. **Do not** use the legacy flat `tastyplates-backend/nhost/metadata/tables/` layout.

### Critical relationship for review functions

`restaurant_reviews.author_id` → `user_profiles.user_id` is exposed in GraphQL as **`AuthorProfile`**:

- File: `nhost/metadata/databases/default/tables/public_restaurant_reviews.yaml`
- Nested: `AuthorProfile { user_id username palates user { avatarUrl email displayName } }`

Nhost Functions query **`AuthorProfile`** directly from Hasura and expose **`AuthorProfile`** in JSON responses (`functions/_lib/review-enrichment.ts`). Mobile clients read **`AuthorProfile`** — same name in Hasura and in function JSON.

**Do not** rename this relationship to `author` in Console — functions and git metadata both expect `AuthorProfile`.

`user_profiles` → `auth.users` is relationship **`user`** (`public_user_profiles.yaml`).

Functions use the **admin secret** for GraphQL (`functions/_lib/hasura.ts`), so deploy issues are usually **untracked tables / missing relationships**, not row-level `select_permissions`. Mobile Apollo (JWT) still needs permissions on tracked tables.

### Local development

From `tastyplates-nhost` (linked project):

```bash
nhost up
```

Applies pending migrations under `nhost/migrations/default/` and loads `nhost/metadata/`.

### Cloud deploy

1. Commit and push **`config.yaml`** (repo root), **`nhost/metadata/`**, and **`nhost/migrations/`** (empty `default/` is OK for metadata-only).
2. Nhost dashboard → Git → **Base directory**:
   - Standalone **`tastyplates-nhost`** repo → `/`
   - **Monorepo** with this folder as subproject → `tastyplates-nhost` (path to the folder that contains `config.yaml`)
3. Push triggers deploy: `nhost.toml` → migrations → **metadata** → functions.
4. In Hasura Console → **Data** → `restaurant_reviews` → **Relationships**: confirm **`AuthorProfile`** exists.

If deploy logs show `cannot find [config.yaml]`, the build commit is missing root `config.yaml` or the Base directory points at the wrong folder. Use [Part 2](#part-2--operations--troubleshooting) for full verification.

### Migrations caution

See `nhost/migrations/README.md`. SQL migrations are **not** in `default/` yet (metadata-only). Before adding FK retarget migrations from `Repo/migrations/`, complete preflight in [final-deprecation-migration.md](./final-deprecation-migration.md) §E-2.

### Out of scope for this metadata bundle

**My Lists** (`user_place_collections`, etc.) is queried from the **mobile app** via Apollo, not from Nhost Functions. Those tables are not in `nhost/metadata/` yet — see [Client GraphQL (mobile)](#client-graphql-mobile-not-in-nhostmetadata).

### Updating metadata

1. Edit YAML under `nhost/metadata/databases/default/tables/`.
2. Test locally with `nhost up`.
3. Push to deploy.

Keep `Repo/metadata` in the monorepo aligned when you change tables in either place.

---

## Part 2 — Operations & troubleshooting

Use this when mobile/functions return **500**, Hasura logs show `validation-failed`, or feeds break after a deploy.

### Quick diagnosis (error → cause)

| Hasura / function log | Meaning | Fix |
|----------------------|---------|-----|
| `cannot find [config.yaml]` | Deploy metadata step: no Hasura CLI project root in Git checkout | Commit root [`config.yaml`](../config.yaml); set Git **Base directory** correctly ([Pre-deploy checklist](#pre-deploy-checklist-git)) |
| `field 'restaurant_reviews' not found in type: 'query_root'` | Table **not tracked** (or metadata never applied) | [Track critical tables](#track-critical-tables-in-console) + successful metadata deploy |
| `field 'author' not found in type: 'restaurant_reviews'` | **Wrong relationship name** — cloud Hasura uses `AuthorProfile`, not `author`; old function build | Update functions to query `AuthorProfile`; ensure `public_restaurant_reviews.yaml` names the relationship `AuthorProfile` |
| `field 'AuthorProfile' not found in type: 'restaurant_reviews'` | Relationship **not tracked** on cloud Hasura | Add `AuthorProfile` → `user_profiles` object relationship in Console; verify git metadata `object_relationships.AuthorProfile` |
| `field 'user' not found in type: 'user_profiles'` | `user_profiles` → `auth.users` link missing | Verify `public_user_profiles.yaml` `object_relationships.user` + `auth_users.yaml` |
| `variable 'userId' is declared as 'uuid!', but used where 'bpchar' is expected` | `user_profiles.user_id` is `String`/`bpchar` in Hasura, not `uuid` | Use `$userId: String!` in `user-profile.ts` queries, or migrate column to `uuid` in Postgres |
| `field 'user_place_collections' not found in type: 'query_root'` | My Lists table not tracked (client GraphQL, not in git metadata) | [Client GraphQL (mobile)](#client-graphql-mobile-not-in-nhostmetadata) |
| `Failed to fetch feed` / `Failed to fetch reviews` (functions) | Any of the above on review handlers | Fix Hasura schema first; **no mobile change** |
| Following tab error but home reviews work | Often **`get-following-feed`** or **`suggested`** — mobile uses `Promise.all` | Test both in [Functions smoke tests](#functions-smoke-tests) |

### Pre-deploy checklist (Git)

From `tastyplates-nhost` repo root:

- [ ] [`config.yaml`](../config.yaml) is **committed** (not gitignored; see [`config.yaml.example`](../config.yaml.example) for local CLI)
- [ ] [`nhost/metadata/`](../nhost/metadata/) is committed (`version.yaml`, `databases/databases.yaml`, `databases/default/tables/tables.yaml`, all `public_*.yaml`, `auth_users.yaml`)
- [ ] [`nhost/migrations/default/`](../nhost/migrations/default/) exists (`.gitkeep` OK for metadata-only)
- [ ] [`nhost/nhost.toml`](../nhost/nhost.toml) deploys successfully (`nhost config validate`)
- [ ] Nhost dashboard → **Git** → **Base directory** matches how the repo is connected:
  - **Standalone `tastyplates-nhost` repo** → `/` (repo root contains `config.yaml`)
  - **Monorepo** (`Tastyplates-project` connected to Nhost) → `tastyplates-nhost` (folder that contains `config.yaml`)
  - Wrong base reproduces `cannot find [config.yaml]` even when the file is committed
- [ ] Secrets exist: `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`, etc.

### Deploy log checklist

After push, open **Nhost → Deployments → latest deploy**:

- [ ] Step **Deploy `nhost.toml`** — success
- [ ] Step **Migrations** — success or skipped (empty `default/` is fine)
- [ ] Step **Apply GraphQL metadata** — **success** (no `config.yaml` fatal, no metadata inconsistency abort)
- [ ] Step **Functions** — success

If metadata step fails, **stop** — cloud GraphQL may be missing tables until fixed.

**Functions redeploy:** If only metadata YAML changed and the metadata step succeeded, functions usually do **not** need a separate redeploy (same deploy run applies both). If you fixed metadata manually in Console without a full Git deploy, push a no-op commit or redeploy functions only if handlers still return old errors.

**Where to read errors:** Nhost → **Deployments** (step logs) → **Observability** / Hasura Console → **API** → GraphiQL; function logs in the deployment’s Functions section.

### Post-deploy: Postgres (table exists)

In Nhost **SQL** or DB console, run:

```sql
SELECT to_regclass('public.restaurant_reviews') AS restaurant_reviews;
SELECT to_regclass('public.user_profiles') AS user_profiles;
SELECT to_regclass('public.restaurants') AS restaurants;
SELECT to_regclass('public.restaurant_user_follows') AS restaurant_user_follows;
```

Each should return the table name, not `NULL`. If `restaurant_reviews` is `NULL`, the table was never created on this database — restore from backup or run schema migrations (not in empty `nhost/migrations/default/` today).

### Track critical tables in Console

**Hasura Console → Data → `public`**

| Table | Required for | In git metadata? |
|-------|----------------|------------------|
| `restaurant_reviews` | Following feed, home reviews, studio, review CRUD | Yes — `public_restaurant_reviews.yaml` |
| `user_profiles` | Author enrichment, profiles, suggested users | Yes — `public_user_profiles.yaml` |
| `restaurants` | Restaurant browse, enrichment `restaurant` brief | Yes — `public_restaurants.yaml` |
| `restaurant_user_follows` | Following feed ID list | Yes — `public_restaurant_user_follows.yaml` |
| `auth.users` (schema `auth`) | `user_profiles.user { avatarUrl displayName email }` | Yes — `auth_users.yaml` |
| `featured_restaurants` | Home carousel | Yes — `public_featured_restaurants.yaml` |
| `restaurant_locations` | Location picker | Yes — `public_restaurant_locations.yaml` |
| `articles` | Articles tab | Yes — `public_articles.yaml` (minimal file; still tracks) |

For each row: status should be **Tracked**. If **Untracked** → **Track** (or re-apply metadata from git).

#### Relationship checks

**`restaurant_reviews` → Relationships**

- [ ] Object relationship **`AuthorProfile`** → `public.user_profiles` (`author_id` → `user_id`)

**`user_profiles` → Relationships**

- [ ] Object relationship **`user`** → `auth.users` (FK on `user_id`)

#### Full tracked set (`tables.yaml`)

Everything below must be **Tracked** after a successful metadata apply (18 table files + `auth.users`). If any are untracked, the matching feature 500s even when the review feed works.

| Table | Required for |
|-------|----------------|
| `restaurant_review_likes` | Review like toggle |
| `restaurant_rating_summary` | Rating summary, browse smart sort |
| `restaurant_cuisine_rating_summary` | Preference / palate stats |
| `restaurant_palates` | Palate picker, search |
| `restaurant_cuisines` | Cuisine filters |
| `restaurant_categories` | Category browse |
| `restaurant_price_ranges` | Price filters |
| `user_favorites` | Wishlist |
| `user_checkins` | Check-ins |
| `restaurant_users` | Legacy profile routes (deprecation in progress) |

Source of truth: [`tables.yaml`](../nhost/metadata/databases/default/tables/tables.yaml).

### GraphQL smoke tests (Console → GraphiQL)

Use **admin** secret or Console.

**Permissions vs tracking:** Nhost Functions call Hasura with the **admin secret** (`functions/_lib/hasura.ts`). For function 500s, prioritize **tracked tables and relationships**, not missing `select_permissions`. Row permissions matter for **mobile Apollo** (JWT / `user` role) and when testing GraphiQL as role `user`.

**A. Root exposes reviews**

```graphql
{
  __type(name: "query_root") {
    fields { name }
  }
}
```

- [ ] `restaurant_reviews` appears in the list

**B. Nested AuthorProfile works**

```graphql
{
  restaurant_reviews(limit: 1) {
    id
    AuthorProfile {
      user_id
      username
      user { displayName email avatarUrl }
    }
  }
}
```

- [ ] No validation error; `AuthorProfile` may be `null` if data missing but field must exist

**C. Following follows table**

```graphql
{
  restaurant_user_follows(limit: 1) {
    user_id
    follower_id
  }
}
```

### Functions smoke tests

Production example: subdomain `ygmkmxorcapgpimwerpc`, region `ap-southeast-1`. Replace `TOKEN` / `USER_UUID` as needed.

```bash
BASE="https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1"

# Public — home trending
curl -s "$BASE/restaurant-reviews/get-all-reviews?limit=1" | jq .ok

# Auth — following feed (Bearer token)
curl -s -H "Authorization: Bearer TOKEN" \
  "$BASE/restaurant-reviews/get-following-feed?user_id=USER_UUID&limit=1" | jq .ok

# Auth optional — suggested users (Following tab loads this in parallel with feed)
curl -s -H "Authorization: Bearer TOKEN" \
  "$BASE/restaurant-users/suggested?limit=6" | jq .ok
```

- [ ] `"ok": true` and `data.reviews` array (may be empty)
- [ ] Review rows include **`AuthorProfile`** with `user_id`, `username`, optional `user.displayName`
- [ ] Following feed rows may include **`restaurant`** `{ uuid, title, slug }`
- [ ] `suggested` returns `{ ok: true }` — requires **`user_profiles`** (+ **`auth.users`** for nested `user` in profile helpers)

**Following tab:** Mobile runs `fetchSuggestedUsers` and `fetchFollowingFeed` in **`Promise.all`** — either endpoint failing shows one generic error even if the other would succeed.

### Metadata file audit (repo)

Verified against `functions/` GraphQL usage.

#### Core tables — present in `tables.yaml`

All included under [`nhost/metadata/databases/default/tables/tables.yaml`](../nhost/metadata/databases/default/tables/tables.yaml).

| File | Notes |
|------|--------|
| `public_restaurant_reviews.yaml` | Permissions + **`AuthorProfile`** → `user_profiles` |
| `public_user_profiles.yaml` | Permissions + **`user`** → `auth.users` |
| `public_restaurants.yaml` | Public read permissions |
| `public_restaurant_user_follows.yaml` | Follow graph |
| `auth_users.yaml` | Admin role for auth user fields |
| `public_restaurant_review_likes.yaml` | Likes |
| `public_restaurant_rating_summary.yaml` | Ratings / preference stats |
| `public_restaurant_cuisine_rating_summary.yaml` | Palate stats |
| `public_featured_restaurants.yaml` | `restaurant` FK relationship |
| `public_restaurant_locations.yaml` | Browse locations |
| `public_articles.yaml` | Table only (no relationships in yaml) |
| `public_restaurant_users.yaml` | Legacy; deprecation path — still tracked |
| `public_user_favorites.yaml` | Wishlist |
| `public_user_checkins.yaml` | Check-ins |
| `public_restaurant_palates.yaml` | Palate search / picker |
| `public_restaurant_cuisines.yaml` | Cuisine filters |
| `public_restaurant_categories.yaml` | Categories |
| `public_restaurant_price_ranges.yaml` | Price ranges |

#### Review author shape (functions → mobile)

- Hasura relationship: **`AuthorProfile`**
- Function JSON / mobile: **`AuthorProfile`** (same name)

Do not rename to `author`. Optional nested restaurant on feed rows uses lowercase **`restaurant`** (batch-loaded in `review-enrichment.ts`, not `ReviewRestaurant` from Hasura).

#### Known gaps (optional / fallback)

| GraphQL field | In metadata? | Impact |
|---------------|--------------|--------|
| `articles.author_profile` | Not in yaml | Article handlers fall back to simple query without author nested |
| `articles.article_restaurant_associations` | Not in yaml | Detail query fails → fallback; batch restaurant merge in functions still works if associations table tracked manually |
| `restaurant_review_mentions` | Not in yaml | Only if you add mention features later |

These gaps do **not** explain `restaurant_reviews` missing from `query_root` — that is always **tracking / metadata apply**.

#### Client GraphQL (mobile, not in `nhost/metadata`)

My Lists uses **Apollo → Hasura** with the user JWT (`tastyplates-mobile/graphql/myLists.ts`), not Nhost Functions:

- `user_place_collections` — list, upsert, delete
- `google_place_cache` — optional; may exist in DB only

If review feeds work but **Studio → My Lists** fails with `field 'user_place_collections' not found`:

1. Confirm the table exists in Postgres (`to_regclass('public.user_place_collections')`).
2. In Hasura Console → **Track** the table and add `select` / `insert` / `update` / `delete` permissions for role **`user`** (or add yaml under `nhost/metadata` and deploy).
3. See mobile runbook: `tastyplates-mobile/documentation/functions/tasty-studio-v1.md` (My Lists section).

This repo does not yet ship metadata for those tables; fixing the review feed deploy does **not** automatically fix My Lists.

### If metadata apply keeps failing

1. **Export current cloud metadata** (Console → Metadata Actions → Export) and diff against `nhost/metadata/` for drift.
2. **Apply incrementally** in Console: track `user_profiles` and `auth.users`, then `restaurant_reviews`, then add **`AuthorProfile`** relationship manually to match yaml.
3. **Re-export** to git once stable (optional).
4. Avoid pushing large metadata + heavy migrations in one deploy; use [metadata-only migrations](../nhost/migrations/README.md) first.

### Mobile impact

| Backend state | Mobile |
|---------------|--------|
| Metadata OK, `AuthorProfile` works | No app update required for review cards |
| 500 from functions | UI shows error from `tastyplatesFetch`; fix Hasura |
| Empty `AuthorProfile` | “Someone” / missing avatar — data or enrichment, not 500 |
| Following tab single error | Check **both** `get-following-feed` and `suggested` ([Functions smoke tests](#functions-smoke-tests)) |
| My Lists GraphQL errors | Separate from this metadata bundle — [Client GraphQL (mobile)](#client-graphql-mobile-not-in-nhostmetadata) |

### Sign-off checklist

When all are true, review feeds and the Following tab should work without mobile changes:

- [ ] Deploy metadata step green
- [ ] `restaurant_reviews` on `query_root`
- [ ] `AuthorProfile { user { … } }` query succeeds in GraphiQL
- [ ] `get-all-reviews` returns `{ ok: true }` without auth
- [ ] `get-following-feed` returns `{ ok: true }` with Bearer token
- [ ] `restaurant-users/suggested` returns `{ ok: true }` (optional auth)
- [ ] Full `tables.yaml` set tracked if you rely on browse, likes, wishlist, or check-ins

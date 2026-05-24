# backend_ai_rules_V1.md — Nhost Backend: Standard Practice & Scaling Rules

> **Scope:** This document is the single authoritative rule guide for developing, deploying, and scaling the `tastyplates-nhost` backend. It is grounded in the actual repository structure (`config.yaml`, `nhost/metadata/`, `nhost/migrations/`, `functions/`, `documentation/`), the real errors encountered during migration, and the decoupled architecture where `tastyplates-v2` is now a pure frontend calling Nhost Functions instead of `/api/v1/` route handlers.
>
> **Format:** Every rule is stated as an enforceable constraint with its rationale, implementation, and the specific failure it prevents. Follow these rules in order when making any change to the backend.

---

## The Core Problem This Document Solves

The repo produces errors like:

- `cannot find [config.yaml]` — deploy fails entirely, no metadata applied
- `field 'AuthorProfile' not found in type: 'restaurant_reviews'` — review feeds break
- `field 'restaurant_reviews' not found in type: 'query_root'` — table not tracked
- `variable 'userId' is declared as 'uuid!', but used where 'bpchar' is expected` — type mismatch between Hasura and GraphQL query

Every one of these happens because **metadata and migrations were added without following the correct order of operations**. This document defines that order and makes it repeatable.

---

## Part 1 — Repository Structure Rules

### Rule 1.1 — The repository layout is non-negotiable

The Nhost deploy pipeline expects a precise file layout. Any deviation causes `cannot find [config.yaml]` or silent metadata failures.

```
tastyplates-nhost/              ← repo root
  config.yaml                   ← MUST be committed, MUST be at root
  config.yaml.example           ← local template only, never deployed
  .secrets.example              ← reference only, never committed with real values
  nhost/
    nhost.toml                  ← service config (Hasura, Auth, Postgres, Observability)
    metadata/                   ← Hasura permissions and relationships (git-controlled)
      version.yaml
      databases/
        databases.yaml
        default/
          tables/
            tables.yaml         ← lists which public_*.yaml files are tracked
            public_*.yaml       ← one file per tracked table
            auth_users.yaml     ← auth.users relationship to user_profiles
    migrations/
      default/                  ← SQL migrations go here; MUST exist even if empty
        .gitkeep                ← required if no migrations yet
    emails/                     ← auth email templates
  functions/                    ← Nhost Functions (HTTP endpoints)
    _lib/                       ← shared helpers (not exposed as routes)
      hasura.ts
      auth.ts
      respond.ts
      validate.ts
    health.ts
    [domain]/
      [action].ts
  documentation/                ← architecture and runbooks
```

> ⚠️ **The `_lib/` prefix is the only way to keep files private.** Any file inside `functions/` that does NOT start with `_` will be exposed as an HTTP endpoint. Never put secrets, shared utilities, or internal helpers in files without the `_lib/` directory prefix.

---

### Rule 1.2 — `config.yaml` must always be committed at the repo root

```yaml
# config.yaml — commit this exactly as shown, do not modify
version: 3
metadata_directory: nhost/metadata
migrations_directory: nhost/migrations
```

**Never `.gitignore` this file.** It is not a secrets file. It is a Hasura CLI project descriptor that tells the Nhost deploy pipeline where to find metadata and migrations.

If this file is missing from the Git checkout, the deploy step that applies metadata is silently skipped — Hasura starts with no tracked tables, no relationships, and no permissions. The frontend will get `field 'X' not found in type: 'query_root'` on every query.

**Verification:**
```bash
# From repo root — must print the file contents, not an error
cat config.yaml
git log --oneline config.yaml  # must show at least one commit
```

---

### Rule 1.3 — The Nhost Dashboard Git base directory must exactly match the repo layout

| Repo setup | Correct base directory setting |
|-----------|-------------------------------|
| `tastyplates-nhost` is a standalone repo (most likely) | `/` |
| `tastyplates-nhost` is a subdirectory inside a monorepo | `tastyplates-nhost` |

**How to check:** Nhost Dashboard → your project → **Git** → **Base directory**.

If the base directory is wrong, Nhost will clone the repo and look for `config.yaml` in the wrong location, producing `cannot find [config.yaml]` in deploy logs even when the file is committed correctly.

**Do not change this setting casually.** After changing it, trigger a manual redeploy from the Nhost Dashboard and verify the deploy log shows `Applying metadata...` — not `cannot find [config.yaml]`.

---

## Part 2 — Metadata Rules

### Rule 2.1 — Metadata is the source of truth for Hasura schema. Never use the Console alone.

All Hasura table tracking, relationships, and permissions must be defined in `nhost/metadata/databases/default/tables/` YAML files and committed to Git. Changes made only in the Hasura Console are lost on the next deploy.

**Workflow for any schema change:**
```
1. Make the change in Hasura Console (for immediate effect locally)
2. Export: nhost metadata export  (or download from Console → Settings → Metadata)
3. Review the diff in nhost/metadata/
4. Commit and push
5. Verify the deploy log shows "Applying metadata..." with no errors
```

> ⚠️ **The problem described in the brief** ("whenever we try to create metadata or migrations, it causes an issue to how I am fetching for data") is caused by the Console and Git being out of sync. Console changes deploy immediately but are overwritten on the next Git push. Git metadata deploys correctly but may be missing changes made in Console. Always export after Console changes.

---

### Rule 2.2 — The `AuthorProfile` relationship name is sacred. Never rename it.

`restaurant_reviews.author_id → user_profiles.user_id` is exposed in GraphQL as **`AuthorProfile`** (capital A, capital P, no spaces).

This exact name is used in:
- `nhost/metadata/databases/default/tables/public_restaurant_reviews.yaml` — the YAML relationship definition
- `functions/_lib/review-enrichment.ts` — all GraphQL queries that fetch review authors
- Every Nhost Function that returns review data to the mobile app

**If this relationship is renamed in Console to `author` or anything else:**
- All Nhost Functions that query reviews will return `field 'AuthorProfile' not found`
- The home feed, following feed, and review detail will all break
- The mobile app will get 500 errors from every review endpoint

**Rule: never rename `AuthorProfile` in Console, never rename it in YAML, never rename it in function queries.**

The YAML definition that must exist in `public_restaurant_reviews.yaml`:

```yaml
object_relationships:
  - name: AuthorProfile
    using:
      manual_configuration:
        column_mapping:
          author_id: user_id
        insertion_order: null
        remote_table:
          name: user_profiles
          schema: public
```

---

### Rule 2.3 — Every tracked table needs a corresponding YAML file AND an entry in `tables.yaml`

`nhost/metadata/databases/default/tables/tables.yaml` is the index. If a table's YAML file exists but is not listed in `tables.yaml`, Hasura silently ignores it. If it is listed but the file is missing, the deploy fails.

**`tables.yaml` must list every tracked table:**

```yaml
# nhost/metadata/databases/default/tables/tables.yaml
- "!include public_restaurant_reviews.yaml"
- "!include public_restaurants.yaml"
- "!include public_user_profiles.yaml"
- "!include public_restaurant_user_follows.yaml"
- "!include public_user_favorites.yaml"
- "!include public_user_checkins.yaml"
- "!include auth_users.yaml"
# Add new tables here whenever you add a public_*.yaml file
```

**When adding a new table:**
```
1. Create nhost/metadata/databases/default/tables/public_<tablename>.yaml
2. Add "- '!include public_<tablename>.yaml'" to tables.yaml
3. Commit both files together in the same commit
4. Never commit tables.yaml without its corresponding .yaml file (deploy will fail)
```

---

### Rule 2.4 — Permissions in metadata only affect JWT (frontend) queries, not admin secret (function) queries

Nhost Functions use the admin secret (`HASURA_GRAPHQL_ADMIN_SECRET`) via `_lib/hasura.ts`. They bypass all row-level permissions. Permission errors in `nhost/metadata/` **do not** affect Nhost Functions.

However, the mobile app uses Apollo with a JWT token. Apollo queries go through Hasura's permission layer. If a table has no `select_permissions` for the `user` role in its YAML, the mobile app cannot query it.

**Rule:** Every table queried directly by the mobile app (not through a function) needs `select_permissions` for the `user` role in its metadata YAML.

```yaml
# Minimum select permission for the user role
select_permissions:
  - role: user
    permission:
      columns: '*'
      filter: {}
      allow_aggregations: true
```

Tables only queried by Nhost Functions (via admin secret) do not need permissions defined in metadata — but they still need to be tracked so they appear in the GraphQL schema.

---

### Rule 2.5 — `nhost/migrations/default/` must exist, even when empty

The Nhost deploy pipeline expects this directory. If it does not exist, the deploy may fail or produce unexpected behaviour.

**If you have no SQL migrations yet:**
```bash
mkdir -p nhost/migrations/default
touch nhost/migrations/default/.gitkeep
git add nhost/migrations/default/.gitkeep
git commit -m "chore: ensure migrations directory exists"
```

---

## Part 3 — Migration Rules

### Rule 3.1 — Migrations are for schema changes only. Never put data in migrations.

SQL migrations in `nhost/migrations/default/` change the Postgres schema (CREATE TABLE, ALTER TABLE, ADD COLUMN, CREATE INDEX). They do not insert data.

**Correct uses of a migration:**
- Adding a new table (`CREATE TABLE user_place_collections (...)`)
- Adding a column to an existing table (`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS google_place_id TEXT`)
- Creating an index (`CREATE INDEX IF NOT EXISTS idx_...`)
- Adding a foreign key constraint

**Incorrect uses (use a seed script or the Hasura Console instead):**
- `INSERT INTO` data rows
- `UPDATE` existing data
- Running backfills (use `admin/backfill-rating-summary` Nhost Function instead)

---

### Rule 3.2 — Migrations must be safe to run multiple times (`IF NOT EXISTS`, `IF EXISTS`)

Every migration in this project must be idempotent. Running it twice on the same database must have no effect after the first run.

```sql
-- ✅ CORRECT — safe to run multiple times
CREATE TABLE IF NOT EXISTS user_place_collections (...);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS google_place_id TEXT;
CREATE INDEX IF NOT EXISTS idx_restaurants_google_place_id ON restaurants (google_place_id);

-- ❌ WRONG — will fail on second run
CREATE TABLE user_place_collections (...);
ALTER TABLE restaurants ADD COLUMN google_place_id TEXT;
```

---

### Rule 3.3 — Add metadata immediately after adding a migration

A migration creates the Postgres table. Metadata tracks it in Hasura. Both must be deployed together. If you add a migration without updating metadata, the table exists in Postgres but is invisible to GraphQL.

**Atomic commit rule:** Every migration commit must also include the corresponding metadata YAML update.

```bash
# Create the migration SQL
# Create nhost/metadata/databases/default/tables/public_<new_table>.yaml
# Add the entry to tables.yaml
# Commit all three together:
git add nhost/migrations/ nhost/metadata/
git commit -m "feat: add user_place_collections table and Hasura metadata"
```

---

### Rule 3.4 — Never modify existing migration files after they have been deployed

Once a migration file is deployed to the Nhost cloud project, it is immutable. To change a column, add a new migration that alters the table. Never edit the original file — Nhost tracks which migrations have been applied by filename and will not re-run them.

---

### Rule 3.5 — Test migrations locally before pushing

```bash
# From tastyplates-nhost root
nhost up          # applies pending migrations + metadata locally
nhost status      # shows which migrations are applied

# Verify the table is accessible via GraphQL
curl -X POST http://localhost:1337/v1/graphql \
  -H "x-hasura-admin-secret: nhost-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ user_place_collections { id } }"}'
```

If this returns `field 'user_place_collections' not found in type: 'query_root'`, the metadata was not applied — check `tables.yaml` and the YAML file.

---

## Part 4 — Nhost Functions Rules

### Rule 4.1 — Every function uses the same response envelope

Every HTTP function must return the shared envelope from `functions/_lib/respond.ts`. Never return raw JSON directly.

```typescript
// ✅ CORRECT
import { ok, fail } from '../_lib/respond';
export default async (req, res) => {
  try {
    const data = await hasuraQuery(...);
    return ok(res, data);
  } catch (e) {
    return fail(res, 'Something went wrong', 500);
  }
};

// ❌ WRONG — bypasses envelope
export default async (req, res) => {
  res.json({ restaurants: [...] });
};
```

The envelope:
```json
// Success
{ "ok": true, "data": <any> }

// Failure
{ "ok": false, "error": "Human-readable message", "details": null }
```

Frontends and mobile clients must always check `ok` before reading `data`.

---

### Rule 4.2 — Functions use the admin secret. Never use user JWT for Hasura queries inside functions.

`functions/_lib/hasura.ts` calls Hasura with `x-hasura-admin-secret`. This bypasses all row-level permissions and always succeeds (assuming the query is valid). This is intentional — functions are the trusted server layer.

```typescript
// ✅ CORRECT — admin secret, bypasses permissions
const { data, errors } = await hasuraQuery<{ restaurants: Restaurant[] }>(
  `query { restaurants(limit: 10) { id name } }`
);

// ❌ WRONG — passing user JWT to Hasura inside a function
const { data } = await fetch(HASURA_ENDPOINT, {
  headers: { Authorization: `Bearer ${userToken}` },
  ...
});
```

**However:** The user JWT is still needed for identity decisions. Parse it using `_lib/auth.ts` to get `x-hasura-user-id` — use that to scope writes (e.g., `INSERT INTO reviews (author_id) VALUES ($userId)` where `$userId` comes from the JWT, never from the request body).

---

### Rule 4.3 — Auth identity always comes from the JWT, never from the request body

This applies to every write operation:

```typescript
// ✅ CORRECT — user identity from JWT
import { verifyJWT } from '../_lib/auth';

const payload = await verifyJWT(req.headers.authorization);
const userId = payload['x-hasura-user-id'];

await hasuraMutation(`
  mutation CreateReview($authorId: uuid!, $body: String!) {
    insert_restaurant_reviews_one(object: { author_id: $authorId, body: $body }) { id }
  }
`, { authorId: userId, body: req.body.body });

// ❌ WRONG — trusting caller-supplied user identity
const { author_id, body } = req.body;  // author_id could be any user
await hasuraMutation(`...`, { authorId: author_id, body });
```

Protected routes that require this pattern: `create-review`, `update-review`, `delete-review`, `toggle-like`, `toggle-favorite`, `toggle-checkin`, `follow`, `unfollow`, `update-restaurant-user`, `get-draft-reviews`, `get-wishlist`, `get-checkins`.

---

### Rule 4.4 — The `hasuraQuery` wrapper is the only way to query Hasura from functions

Never call `fetch(HASURA_ENDPOINT, ...)` directly in a function file. Use the shared wrapper.

```typescript
// functions/_lib/hasura.ts — the only Hasura client
import process from 'node:process';

const ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT!;
const SECRET   = process.env.HASURA_GRAPHQL_ADMIN_SECRET!;

export async function hasuraQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors?: unknown[] }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: T | null; errors?: unknown[] }>;
}

export const hasuraMutation = hasuraQuery;
```

**After calling `hasuraQuery`, always check for errors before reading data:**

```typescript
const { data, errors } = await hasuraQuery<{ restaurants: Restaurant[] }>(...);
if (errors?.length) {
  return fail(res, `Hasura error: ${JSON.stringify(errors[0])}`, 500);
}
if (!data?.restaurants) {
  return fail(res, 'No data returned', 500);
}
```

---

### Rule 4.5 — Function files that are not endpoints must live under `functions/_lib/`

Nhost routes every `.ts` file under `functions/` that does not start with `_` as an HTTP endpoint. To prevent internal utilities from becoming public endpoints:

```
functions/
  _lib/               ← private (not exposed)
    hasura.ts
    auth.ts
    respond.ts
    validate.ts
    review-enrichment.ts
    cursor.ts
  health.ts            ← public: /v1/health
  restaurants/
    get-restaurants.ts ← public: /v1/restaurants/get-restaurants
```

**Never create a `utils.ts` or `helpers.ts` directly under `functions/` or any subdirectory without the `_lib/` prefix.**

---

### Rule 4.6 — GraphQL queries in functions must use variable types that match the actual Postgres column types

This is the cause of `variable 'userId' is declared as 'uuid!' but used where 'bpchar' is expected`.

`user_profiles.user_id` is stored as `character varying` (`bpchar`) in Postgres, not as `uuid`, even though values are UUID-shaped. Hasura reflects the actual Postgres type in the GraphQL schema.

**Correct GraphQL variable type for `user_profiles.user_id`:**

```graphql
# ✅ CORRECT
query GetUserProfile($userId: String!) {
  user_profiles(where: { user_id: { _eq: $userId } }) { ... }
}

# ❌ WRONG — will fail at Hasura validation
query GetUserProfile($userId: uuid!) {
  user_profiles(where: { user_id: { _eq: $userId } }) { ... }
}
```

**Rule:** Before writing any function query, verify the actual column type in Hasura Console → Data → [table] → Columns. Use the GraphQL type Hasura assigns, not what you expect the column to be.

---

## Part 5 — The Safe Deploy Order

Follow this exact order every time you make a backend change. Skipping steps or reordering them is the primary cause of Hasura becoming out of sync with the live data.

```
Step 1 — Write the SQL migration (if schema changes)
  File: nhost/migrations/default/<timestamp>_<description>/up.sql
  Rule: IF NOT EXISTS on all DDL statements
  Do not push yet.

Step 2 — Write the metadata YAML (if new table or relationship)
  File: nhost/metadata/databases/default/tables/public_<tablename>.yaml
  Update: nhost/metadata/databases/default/tables/tables.yaml (add the include)
  Do not push yet.

Step 3 — Test locally
  nhost up            ← applies migration + metadata
  nhost status        ← verify migration applied
  curl localhost/graphql  ← verify table is queryable

Step 4 — Write or update the Nhost Function (if API change)
  File: functions/<domain>/<action>.ts
  Use: hasuraQuery(), ok(), fail(), verifyJWT() from _lib/
  Test: curl the local function URL

Step 5 — Commit everything atomically
  git add nhost/migrations/ nhost/metadata/ functions/
  git commit -m "feat: describe the complete change"
  git push

Step 6 — Verify the Nhost cloud deploy
  Nhost Dashboard → Deployments → latest deploy
  Check for: "Applying metadata..." (must appear)
  Check for: "migrations applied: N" (must match what you added)
  Check for: zero error lines

Step 7 — Smoke test the live endpoint
  curl {FUNCTIONS_URL}/v1/health
  curl {FUNCTIONS_URL}/v1/<new-domain>/<new-action>
  Open the mobile app and verify the affected screen works
```

---

## Part 6 — Diagnosing and Fixing Live Errors

### Error → Cause → Fix table

| Error message | Root cause | Fix |
|--------------|-----------|-----|
| `cannot find [config.yaml]` | `config.yaml` missing from Git or wrong base directory | Commit `config.yaml` to repo root; verify Git base directory in Nhost Dashboard |
| `field 'X' not found in type: 'query_root'` | Table not tracked in Hasura metadata | Add `public_X.yaml` + entry in `tables.yaml`; push and redeploy |
| `field 'AuthorProfile' not found in type: 'restaurant_reviews'` | Relationship renamed or not in metadata | Restore `AuthorProfile` in `public_restaurant_reviews.yaml`; push; verify in Console |
| `field 'author' not found in type: 'restaurant_reviews'` | Function is querying old `author` field name | Update function to query `AuthorProfile`; do NOT rename the metadata relationship |
| `variable 'userId' is declared as 'uuid!' but used where 'bpchar' is expected` | GraphQL variable type mismatch with actual Postgres column | Change query variable to `$userId: String!` (user_profiles.user_id is varchar) |
| `field 'user_place_collections' not found` | New table not tracked | Add migration + metadata + `tables.yaml` entry; push atomically |
| Console changes work but break after next push | Console changes not exported to Git | Run `nhost metadata export`; commit; push |
| Following feed breaks, home reviews work | `get-following-feed` function or `AuthorProfile` relationship issue | Test the function directly with curl; check Hasura for relationship on cloud |
| Metadata applied but permissions denied (mobile Apollo) | `select_permissions` missing for `user` role in YAML | Add `select_permissions` block to the table's YAML; push |
| `Applying metadata... ❌` in deploy log | Invalid YAML syntax or missing referenced table | Check YAML syntax; ensure all `!include` entries in `tables.yaml` have corresponding files |

---

### How to verify `AuthorProfile` is live on cloud

```bash
curl -X POST https://<subdomain>.hasura.<region>.nhost.run/v1/graphql \
  -H "x-hasura-admin-secret: <HASURA_GRAPHQL_ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ restaurant_reviews(limit: 1) { id AuthorProfile { user_id username } } }"
  }'
```

If this returns data → `AuthorProfile` relationship is live.
If this returns `field 'AuthorProfile' not found` → metadata was not applied or relationship is missing.

---

### How to export metadata after Console changes

```bash
# From tastyplates-nhost repo root, with nhost CLI logged in and linked
nhost metadata export

# Review the diff
git diff nhost/metadata/

# Commit
git add nhost/metadata/
git commit -m "chore: export Hasura metadata after Console changes"
git push
```

---

## Part 7 — Secrets and Environment Variables

### Rule 7.1 — Secrets are never committed. They are set in the Nhost Dashboard.

```
# .secrets.example — reference only, never commit with real values
HASURA_GRAPHQL_ADMIN_SECRET=<your-admin-secret>
HASURA_GRAPHQL_JWT_SECRET=<your-jwt-secret>
GRAFANA_ADMIN_PASSWORD=<your-grafana-password>
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>
```

Set these at: Nhost Dashboard → your project → **Settings → Secrets**.

Functions access them as `process.env.HASURA_GRAPHQL_ADMIN_SECRET` etc. — Nhost injects them at runtime.

### Rule 7.2 — The `.secrets` file must be in `.gitignore`

```
# .gitignore — ensure these are present
.secrets
.env
.env.local
config.yaml.example  ← local only, not the committed config.yaml
```

---

## Part 8 — Frontend ↔ Backend Contract

### Rule 8.1 — The frontend calls Nhost Functions, never Hasura directly

`tastyplates-v2` is a pure frontend. It does not call Hasura's GraphQL endpoint directly (except for the mobile app's Apollo client, which uses the user JWT through Hasura's permission layer for tables that the frontend queries directly).

The API hierarchy:
```
Mobile app (Apollo + JWT)  →  Hasura (tracked tables, user permissions)
tastyplates-v2 frontend    →  Nhost Functions URL  →  Hasura (admin secret)
```

### Rule 8.2 — The frontend environment variable for functions is `NEXT_PUBLIC_FUNCTIONS_URL`

```bash
# tastyplates-v2 .env.local
NEXT_PUBLIC_FUNCTIONS_URL=https://<subdomain>.functions.<region>.nhost.run/v1
```

Never hardcode this URL in service files. Always read from `process.env.NEXT_PUBLIC_FUNCTIONS_URL`.

### Rule 8.3 — Frontend services must check `ok` before reading `data`

Every call to a Nhost Function returns `{ ok: boolean, data?: T, error?: string }`. Frontend code must handle both cases:

```typescript
const result = await apiFetch<Restaurant[]>('/restaurants-v2/get-restaurants?limit=10');
if (!result.ok) {
  // Handle error — result.error has the message
  throw new Error(result.error ?? 'Unknown error');
}
// result.data is now typed as Restaurant[]
return result.data;
```

---

## Part 9 — What Never Goes in This Repo

| Item | Reason | Where it belongs |
|------|--------|-----------------|
| Next.js pages, components, hooks | Frontend concern | `tastyplates-v2` |
| `/api/v1/` route handlers | Being deprecated, now replaced by functions | Delete from `tastyplates-v2` per decouple plan |
| Nhost Auth configuration (Google OAuth, email templates) | Handled by `nhost.toml` and `nhost/emails/` | Already in this repo correctly |
| Legal/content pages | Static content, better as Next.js ISR | `tastyplates-v2` pages |
| DB seed data | Not a migration concern | Separate seed scripts or Hasura Console |
| API keys, client secrets | Never committed | Nhost Dashboard → Secrets |

---

## Quick Reference — Deployment Checklist

Before every push that touches `nhost/`:

- [ ] `config.yaml` is committed at repo root
- [ ] Every new table has a `public_<tablename>.yaml` file
- [ ] Every new YAML file is listed in `tables.yaml` with `!include`
- [ ] `nhost/migrations/default/` exists (`.gitkeep` if empty)
- [ ] `AuthorProfile` relationship is present in `public_restaurant_reviews.yaml`
- [ ] All DDL in migrations uses `IF NOT EXISTS` / `IF EXISTS`
- [ ] Migration and metadata changes are in the same commit
- [ ] `nhost up` was run locally and the change works
- [ ] Nhost Dashboard → Git → Base directory is set to `/` (standalone repo)
- [ ] Secrets are set in Nhost Dashboard, not committed to Git

After every push:

- [ ] Deploy log shows `Applying metadata...` with no errors
- [ ] `curl {FUNCTIONS_URL}/v1/health` returns `{ "ok": true }`
- [ ] Affected screen in mobile/frontend works end-to-end
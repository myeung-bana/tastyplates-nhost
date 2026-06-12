# Tastyplates Nhost — API & Hasura (v3)

Combined reference for **Hasura setup**, **deploy operations**, **media upload (Nhost Storage)**, and how they connect to **Nhost Functions** and the mobile app.

**Supersedes:** [api-doc-v2.md](./api-doc-v2.md) — v3 adds the Nhost Storage upload pipeline, `media_assets` catalog, restaurant-lists prerequisites, and upload troubleshooting.

| Doc | Scope |
|-----|--------|
| [api-guide.md](./api-guide.md) | HTTP functions: routes, auth, request/response envelope, endpoint catalog |
| **This doc (v3)** | Hasura layout, metadata deploy, **media upload infra**, troubleshooting, smoke tests |
| [media_assets-hasura-setup.md](./media_assets-hasura-setup.md) | Quick checklist for `public.media_assets` |
| [my-lists-hasura-setup.md](./my-lists-hasura-setup.md) | My Lists tables (`user_place_collections`) — client GraphQL |
| [migrations/add_media_assets.sql](./migrations/add_media_assets.sql) | `media_assets` DDL (run manually in Nhost SQL) |
| [final-deprecation-migration.md](./final-deprecation-migration.md) | FK retarget preflight (§E-2) |
| [decouple-plan.md](./decouple-plan.md) | Monorepo decouple context |

---

## What changed in v3

| Area | v2 | v3 (current) |
|------|----|--------------|
| Image uploads | S3 (`PutObjectCommand`) implied in older mobile docs | **Nhost Storage** (`tasty-bucket`) + `public.media_assets` catalog |
| Upload handlers | Not covered in v2 | `upload/image`, `upload/batch`, `admin/migrate-media` |
| Multipart parsing | — | `req.rawBody` → `Readable.from().pipe(busboy)` (Nhost Functions) |
| Dedup | — | SHA-256 on compressed bytes; repair orphan catalog rows on re-upload |
| Restaurant lists | Partially in api-guide only | Hasura relationship + upload URL flow documented here |
| Secrets | Admin + JWT | + `MEDIA_STORAGE_BUCKET`, optional `IMAGE_*`, `MEDIA_MIGRATION_ACTOR_ID` |

---

## Part 1 — Hasura metadata & migrations

### Repo layout

```
config.yaml              # Hasura CLI root (metadata_directory → nhost/metadata)
config.yaml.example
nhost/
  nhost.toml             # Auth, functions node 22, storage, postgres
  metadata/              # May be empty or maintained in Console — see note below
  migrations/            # SQL migrations (media_assets DDL also in documentation/migrations/)
  emails/
functions/
  upload/image.ts        # Multipart → Sharp → Nhost Storage → media_assets
  _lib/media-upload/     # Shared upload pipeline
```

**Metadata note:** `config.yaml` points at `nhost/metadata/`. If that folder is not committed (metadata applied via Hasura Console), Git deploy may skip or fail the metadata step. Track tables and relationships in Console, or commit YAML under `nhost/metadata/databases/default/tables/` and redeploy.

### Critical relationship for review functions

`restaurant_reviews.author_id` → `user_profiles.user_id` is exposed in GraphQL as **`AuthorProfile`**:

- Nested: `AuthorProfile { user_id username palates user { avatarUrl email displayName } }`

Nhost Functions query **`AuthorProfile`** from Hasura and expose **`AuthorProfile`** in JSON (`functions/_lib/review-enrichment.ts`). Mobile clients read **`AuthorProfile`** — same name in Hasura and function JSON.

**Do not** rename this relationship to `author` in Console — functions expect `AuthorProfile`.

`user_profiles` → `auth.users` is relationship **`user`**.

Functions use the **admin secret** for GraphQL (`functions/_lib/hasura.ts`). Deploy issues are usually **untracked tables / missing relationships**, not row-level `select_permissions` on the admin path. Mobile Apollo (JWT) still needs permissions on tracked tables.

### Local development

From `tastyplates-nhost` (linked project):

```bash
nhost up
```

Applies pending migrations under `nhost/migrations/default/` and loads `nhost/metadata/` when present.

### Cloud deploy

1. Commit and push **`config.yaml`**, **`nhost/nhost.toml`**, **`functions/`**, and metadata/migrations when you use Git-managed Hasura.
2. Nhost dashboard → Git → **Base directory**:
   - Standalone **`tastyplates-nhost`** repo → `/`
   - **Monorepo** → `tastyplates-nhost` (folder containing `config.yaml`)
3. Push triggers deploy: `nhost.toml` → migrations → **metadata** → **functions**.
4. After deploy, verify critical relationships in Hasura Console (see [Track critical tables](#track-critical-tables-in-console)).

If deploy logs show `cannot find [config.yaml]`, the build commit is missing root `config.yaml` or the Base directory is wrong.

### Migrations caution

SQL for new features lives under `documentation/migrations/` (e.g. `add_media_assets.sql`) until promoted into `nhost/migrations/default/`. Run DDL in Nhost **SQL** or migrate via CLI before expecting upload or catalog features to work.

Before adding FK retarget migrations from legacy repos, complete preflight in [final-deprecation-migration.md](./final-deprecation-migration.md) §E-2.

---

## Part 2 — Media upload (Nhost Storage)

Uploads are **Nhost-only** — no AWS S3 SDK in functions. Legacy S3 URLs are migrated via `admin/migrate-media`.

### Architecture

```
Mobile / Web client
  POST multipart/form-data  field: file
  Authorization: Bearer <JWT>
        │
        ▼
functions/upload/image.ts
  1. requireAuth (JWT)
  2. parseSingleFile (Busboy + req.rawBody)
  3. Sharp → AVIF (fallback WebP)
  4. SHA-256 dedup → media_assets
  5. POST → Nhost Storage (tasty-bucket)
  6. insert/update media_assets row
        │
        ▼
Response: { ok: true, data: { fileUrl, filePath, mediaUuid, deduped } }
```

`upload/batch` runs the same pipeline per file (up to `UPLOAD_BATCH_MAX_FILES`, default 10).

### Multipart parsing (Nhost Functions)

Nhost pre-buffers request bodies as **`req.rawBody`**. The parser in `functions/_lib/media-upload/parseMultipart.ts`:

- If `rawBody` exists → `Readable.from(rawBody).pipe(busboy)` (preserves stream timing)
- Else → `req.pipe(busboy)` (local dev)

Do **not** use `busboy.end(rawBody)` — it fires `finish` before file streams drain and causes **`No file received`**.

### Response shape

`POST /v1/upload/image` success:

```json
{
  "ok": true,
  "data": {
    "fileUrl": "https://<subdomain>.storage.<region>.nhost.run/v1/files/<uuid>",
    "filePath": "storage/<uuid>",
    "mediaUuid": "<catalog-uuid>",
    "deduped": false
  }
}
```

| Field | Use |
|-------|-----|
| `fileUrl` | Store on entities (`profile_image`, `display_pic`, review `images[]`, etc.) |
| `filePath` | Internal reference (`storage/<fileId>`) |
| `mediaUuid` | `media_assets.uuid` for audit/dedup |
| `deduped` | `true` if an existing catalog + storage file was reused |

### Client rules

- **Field name:** `file` (any file field name is accepted; mobile uses `file`).
- **Do not** set `Content-Type` manually — let `FormData` set the boundary.
- **Auth:** Bearer access token required.
- Mobile: `tastyplates-mobile/services/uploadService.ts` → `EXPO_PUBLIC_NHOST_FUNCTIONS_URL/upload/image`.
- Web: `tastyplates-v2-1/src/app/api/v1/upload/image/route.ts` proxies multipart to the same function.

### Secrets & config

Set in Nhost Dashboard → **Secrets** (and local `.secrets`):

| Secret | Default | Purpose |
|--------|---------|---------|
| `MEDIA_STORAGE_BUCKET` | `tasty-bucket` | Nhost Storage bucket id |
| `IMAGE_MAX_WIDTH` | `1600` | Sharp resize |
| `IMAGE_MAX_HEIGHT` | `1600` | Sharp resize |
| `IMAGE_AVIF_QUALITY` | `60` | AVIF quality |
| `IMAGE_WEBP_QUALITY` | `75` | WebP fallback quality |
| `UPLOAD_BATCH_MAX_FILES` | `10` | Batch upload cap |
| `MEDIA_MIGRATION_ACTOR_ID` | — | Optional UUID for `uploaded_by` when `admin/migrate-media` migrates restaurant images |

Also required (existing): `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`.

See [`.secrets.example`](../.secrets.example).

### Storage bucket

1. Nhost Dashboard → **Storage** → create bucket **`tasty-bucket`** (or match `MEDIA_STORAGE_BUCKET`).
2. Enable **public download** so `fileUrl` works in `<Image>` / review cards without presigned URLs.
3. Redeploy functions after secret changes.

### `public.media_assets` catalog

1. Run SQL: [`documentation/migrations/add_media_assets.sql`](./migrations/add_media_assets.sql) in Nhost SQL editor.
2. Track table in Hasura Console.
3. Permissions for role **`user`** — see [media_assets-hasura-setup.md](./media_assets-hasura-setup.md):
   - **Select** only (filter `uploaded_by = X-Hasura-User-Id`)
   - **No insert/update/delete** for `user` — writes go through `POST upload/image` (admin secret).

Catalog insert failures surface as **500** with message like `Failed to save media catalog entry` — fix tracking and admin secret before blaming the client.

### Where URLs are stored (after upload)

| Feature | Column / field | Set via |
|---------|----------------|---------|
| Profile photo | `user_profiles.profile_image` | `upload/image` → `update-restaurant-user` |
| List cover | `recommended_restaurant_lists.display_pic` | `upload/image` → `create-list` / `update-list` |
| Review photos | `restaurant_reviews.images` (array) | `upload/image` per photo → `create-review` |
| Restaurant featured image | `restaurants.featured_image_url` | Admin / migrate path |

### Admin: legacy S3 migration

`POST /v1/admin/migrate-media` — header `x-admin-secret: <HASURA_GRAPHQL_ADMIN_SECRET>`

Query: `limit` (default 20), `dry_run=true|false`

Re-fetches legacy `amazonaws.com` URLs on profiles, list covers, restaurant featured images, and review image arrays; re-uploads to Nhost Storage and updates rows.

### Upload smoke tests

```bash
BASE="https://<subdomain>.functions.<region>.nhost.run/v1"
TOKEN="<access_token>"

# Single image
curl -sS -X POST "$BASE/upload/image" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/photo.jpg;type=image/jpeg" | jq .

# Expect: ok true, data.fileUrl starts with storage host
```

- [ ] `{ "ok": true }` and HTTPS `fileUrl`
- [ ] New row in Nhost Storage → Files (bucket `tasty-bucket`)
- [ ] New row in `media_assets` (Hasura or SQL)
- [ ] Re-uploading same image may return `deduped: true`

### Upload troubleshooting

| Log / symptom | Likely cause | Fix |
|---------------|--------------|-----|
| `No file received` | Multipart not reaching Busboy (old `busboy.end` race, or empty body) | Deploy latest `parseMultipart.ts` (`Readable.from(rawBody).pipe`); verify client sends `FormData` with `file` |
| `Unauthorized` | Missing/expired JWT | Sign in; gate upload on session ready |
| `Storage upload failed (4xx/5xx)` | Bucket missing, wrong `MEDIA_STORAGE_BUCKET`, or admin secret | Create bucket; fix secrets; redeploy |
| `Failed to save media catalog entry` | `media_assets` not tracked or admin secret wrong | Run DDL; track table; verify `HASURA_GRAPHQL_ADMIN_SECRET` |
| `field 'media_assets' not found` | Table not tracked | Track in Console |
| `field 'uuid' not found in type: 'media_assets'` | Legacy table uses `id` not `uuid` | Deploy latest `mediaAssetsCatalog.ts`; reload Hasura metadata |
| File in Storage but app shows error | Catalog insert failed after storage POST | Check function logs after storage step; fix Hasura |
| `deduped: true` but image 404 | Orphan catalog row (storage file deleted) | Re-upload same file — pipeline repairs row |

---

## Part 3 — Operations & troubleshooting (reviews & feeds)

Use this when mobile/functions return **500**, Hasura logs show `validation-failed`, or feeds break after a deploy.

### Quick diagnosis (error → cause)

| Hasura / function log | Meaning | Fix |
|----------------------|---------|-----|
| `cannot find [config.yaml]` | Deploy metadata step: no Hasura CLI project root in Git checkout | Commit root [`config.yaml`](../config.yaml); set Git **Base directory** correctly |
| `field 'restaurant_reviews' not found in type: 'query_root'` | Table **not tracked** | [Track critical tables](#track-critical-tables-in-console) |
| `field 'author' not found in type: 'restaurant_reviews'` | Wrong relationship name — use **`AuthorProfile`** | Fix Console relationship + function queries |
| `field 'AuthorProfile' not found in type: 'restaurant_reviews'` | Relationship not tracked | Add `AuthorProfile` → `user_profiles` |
| `field 'user' not found in type: 'user_profiles'` | `user_profiles` → `auth.users` missing | Track `auth.users` + relationship **`user`** |
| `variable 'userId' is declared as 'uuid!', but used where 'bpchar' is expected` | `user_profiles.user_id` type mismatch | Use `String!` in queries or migrate column to `uuid` |
| `field 'user_place_collections' not found` | My Lists not tracked (client GraphQL) | [my-lists-hasura-setup.md](./my-lists-hasura-setup.md) |
| `field 'recommended_restaurant_lists' not found` | Restaurant lists not tracked | Track list tables; see [Restaurant lists Hasura](#restaurant-lists-hasura) |
| `Failed to fetch feed` / `Failed to fetch reviews` | Hasura schema issue on review handlers | Fix tracking/relationships first |
| Following tab error, home OK | **`get-following-feed`** and/or **`suggested`** | Test both in [Functions smoke tests](#functions-smoke-tests) |

### Pre-deploy checklist (Git)

From `tastyplates-nhost` repo root:

- [ ] [`config.yaml`](../config.yaml) committed
- [ ] [`nhost/nhost.toml`](../nhost/nhost.toml) validates (`nhost config validate`)
- [ ] [`functions/`](../functions/) includes latest upload handlers
- [ ] Git **Base directory** correct (standalone `/` vs monorepo `tastyplates-nhost`)
- [ ] Secrets: `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`, `MEDIA_STORAGE_BUCKET`
- [ ] Storage bucket `tasty-bucket` exists with public download
- [ ] `media_assets` SQL applied and table tracked (if using uploads)

### Deploy log checklist

After push, Nhost → **Deployments** → latest:

- [ ] **Deploy `nhost.toml`** — success
- [ ] **Migrations** — success or skipped
- [ ] **Apply GraphQL metadata** — success (if using git metadata)
- [ ] **Functions** — success

**Functions-only fix:** Push a commit touching `functions/` or redeploy functions after upload parser changes — metadata-only deploys do not refresh function code.

### Post-deploy: Postgres sanity

```sql
SELECT to_regclass('public.restaurant_reviews') AS restaurant_reviews;
SELECT to_regclass('public.user_profiles') AS user_profiles;
SELECT to_regclass('public.restaurants') AS restaurants;
SELECT to_regclass('public.media_assets') AS media_assets;
SELECT to_regclass('public.recommended_restaurant_lists') AS recommended_restaurant_lists;
```

Each should return the table name, not `NULL`.

### Track critical tables in Console

**Hasura Console → Data → `public`**

| Table | Required for | Upload-related |
|-------|----------------|----------------|
| `restaurant_reviews` | Feeds, studio, review CRUD | Review `images[]` URLs |
| `user_profiles` | Author enrichment, profiles | `profile_image` |
| `restaurants` | Browse, enrichment | `featured_image_url` |
| `restaurant_user_follows` | Following feed | — |
| `media_assets` | Upload catalog, dedup | **Yes** — required for `upload/image` |
| `recommended_restaurant_lists` | User playlists | `display_pic` |
| `recommended_restaurant_list_items` | List items + aggregates | — |
| `featured_restaurants` | Home carousel | — |
| `restaurant_locations` | Location picker | — |
| `articles` | Articles tab | — |
| `auth.users` (schema `auth`) | Nested `user` on profiles | — |

#### Relationship checks

**`restaurant_reviews`**

- [ ] Object **`AuthorProfile`** → `public.user_profiles` (`author_id` → `user_id`)

**`user_profiles`**

- [ ] Object **`user`** → `auth.users`

**`recommended_restaurant_lists`**

- [ ] Array **`recommended_restaurant_list_items`** → items table (`list_id` FK) — required for `items_count` on `get-my-lists`

### Restaurant lists Hasura

User-curated playlists use `recommended_restaurant_lists` + `recommended_restaurant_list_items`. Functions under `restaurant-lists/` query via admin secret.

| Requirement | Why |
|-------------|-----|
| Both tables **tracked** | All list endpoints GraphQL |
| FK relationship list → items | `get-my-lists` nested aggregate for `items_count` |
| `display_pic` column (text) | HTTPS URL from `upload/image` → `fileUrl` |

Cover image flow:

1. `POST upload/image` with Bearer → `data.fileUrl`
2. `POST restaurant-lists/create-list` or `PATCH update-list` with `"display_pic": "<fileUrl>"`

Full HTTP contract: [api-guide.md § Restaurant lists](./api-guide.md#8-restaurant-lists-user-curated-playlists).

### GraphQL smoke tests (Console → GraphiQL)

**A. Reviews root**

```graphql
{
  __type(name: "query_root") {
    fields { name }
  }
}
```

- [ ] `restaurant_reviews` listed

**B. AuthorProfile**

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

**C. media_assets (after upload DDL)**

```graphql
{
  media_assets(limit: 1) {
    uuid
    public_url
    storage_file_id
    uploaded_by
  }
}
```

### Functions smoke tests

```bash
BASE="https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1"

# Public — home trending
curl -s "$BASE/restaurant-reviews/get-all-reviews?limit=1" | jq .ok

# Auth — following feed
curl -s -H "Authorization: Bearer TOKEN" \
  "$BASE/restaurant-reviews/get-following-feed?user_id=USER_UUID&limit=1" | jq .ok

# Auth optional — suggested (Following tab parallel load)
curl -s -H "Authorization: Bearer TOKEN" \
  "$BASE/restaurant-users/suggested?limit=6" | jq .ok

# Upload (see Part 2)
curl -sS -X POST "$BASE/upload/image" \
  -H "Authorization: Bearer TOKEN" \
  -F "file=@photo.jpg;type=image/jpeg" | jq .
```

- [ ] Review endpoints return `{ "ok": true }` with **`AuthorProfile`** on rows
- [ ] Upload returns `{ "ok": true, "data": { "fileUrl": "..." } }`
- [ ] `get-my-lists` returns lists with `items_count` when list metadata is tracked

**Following tab:** Mobile runs `fetchSuggestedUsers` and `fetchFollowingFeed` in **`Promise.all`** — either failure shows one generic error.

### Client GraphQL (mobile, not all in git metadata)

| Feature | Tables | Doc |
|---------|--------|-----|
| My Lists (To-Dine / Check-ins) | `user_place_collections`, `google_place_cache` | [my-lists-hasura-setup.md](./my-lists-hasura-setup.md) |
| Restaurant playlists | `recommended_restaurant_lists` (via **functions**, not Apollo) | [api-guide.md](./api-guide.md) |

Fixing review-feed metadata does **not** automatically fix My Lists or uploads — each has separate prerequisites (Part 2 + my-lists doc).

### Mobile impact

| Backend state | Mobile |
|---------------|--------|
| Metadata OK, `AuthorProfile` works | No app update for review cards |
| Upload OK | Profile, list cover, review photos work via `uploadService.ts` |
| 500 from functions | UI error from `tastyplatesFetch` / `uploadMediaAsset` — fix backend |
| Empty `AuthorProfile` | “Someone” / missing avatar — data issue, not 500 |
| Upload 500 `No file received` | Deploy latest `parseMultipart.ts` |
| My Lists GraphQL errors | Separate from review metadata — track `user_place_collections` |

### Sign-off checklist

**Review feeds**

- [ ] Deploy metadata/functions green
- [ ] `restaurant_reviews` on `query_root`
- [ ] `AuthorProfile { user { … } }` succeeds in GraphiQL
- [ ] `get-all-reviews` and `get-following-feed` return `{ ok: true }`
- [ ] `restaurant-users/suggested` returns `{ ok: true }`

**Media upload**

- [ ] `tasty-bucket` exists, public download enabled
- [ ] `MEDIA_STORAGE_BUCKET` secret set
- [ ] `media_assets` table exists and tracked
- [ ] `upload/image` curl smoke test returns `fileUrl`
- [ ] Mobile profile or review photo upload succeeds end-to-end

**Restaurant lists (if using Studio playlists)**

- [ ] `recommended_restaurant_lists` + items tracked
- [ ] `get-my-lists` returns `{ ok: true }`
- [ ] Cover upload → `display_pic` persists on list row

---

## Part 4 — Related docs

| Document | Purpose |
|----------|---------|
| [api-guide.md](./api-guide.md) | Full HTTP endpoint catalog and client examples |
| [api-doc-v2.md](./api-doc-v2.md) | Previous combined doc (review-feed focus) |
| [AI_rules.md](./AI_rules.md) | Implementation rules for functions |
| [media_assets-hasura-setup.md](./media_assets-hasura-setup.md) | Short `media_assets` Console steps |
| `tastyplates-mobile/documentation/functions/media-upload.md` | Canonical cross-repo upload spec |

When in doubt about an HTTP contract, open the handler under `functions/` or see [api-guide.md](./api-guide.md).

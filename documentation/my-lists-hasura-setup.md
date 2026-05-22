# Hasura setup — My Lists (`user_place_collections`, `google_place_cache`)

Apply SQL from project root: `Repo/migrations/default/20260520120000_tasty_studio_my_lists/up.sql`, then:

## 1. Track tables

In Hasura Console: **Data** → track `public.user_place_collections` and `public.google_place_cache`.

## 2. `user_place_collections` permissions (role aligned with mobile JWT, typically `user` / `default`)

### Select

Filter: `{ user_id: { _eq: X-Hasura-User-Id } }`

Columns: expose all scalar columns needed by the mobile app (`id`, `user_id`, `list_type`, `google_place_id`, snapshots, TP link fields, `location_*`, timestamps).

### Insert

Row check (optional strict): `{ user_id: { _eq: X-Hasura-User-Id } }`  
Preset column: **`user_id` = X-Hasura-User-Id** (recommended so the client never sends another user id).

### Update (same as select filter if you allow snapshot refresh)

Same filter `{ user_id: { _eq: X-Hasura-User-Id } }` with appropriate columns limited.

### Delete

Filter: `{ user_id: { _eq: X-Hasura-User-Id } }`.

## 3. `google_place_cache`

Prefer **backend-only** or **admin/service role** Refresh from a Cron / function. If readable by anon for cache hits, tighten as needed—do not expose writable permissions to anon.

## 4. Upsert mutations

PostgreSQL constraint name used in migration:

`user_place_collections_user_google_list_unique` on `(user_id, google_place_id, list_type)`.

In GraphQL **`on_conflict.constraint`** use the Enum value Hasura generates (often **`user_place_collections_user_google_list_unique`**). Confirm from **GraphiQL sidebar** → `insert_user_place_collections_one` arguments.

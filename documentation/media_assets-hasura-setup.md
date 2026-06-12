# Hasura setup — `public.media_assets`

Production uses the **legacy** `media_assets` table (PK column `id`, not `uuid`). Nhost Storage file ids are stored in `s3_key` with `s3_bucket = tasty-bucket`.

## 1. Confirm table exists

In Nhost **SQL**:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'media_assets'
ORDER BY ordinal_position;
```

Expected columns include: `id`, `s3_bucket`, `s3_key`, `public_url`, `sha256`, `content_type`, `size_bytes`, `original_filename`, `uploaded_by_user_id`, `created_at`, `updated_at`, `deleted_at`.

If the table is missing, run [`migrations/add_media_assets_legacy_patch.sql`](./migrations/add_media_assets_legacy_patch.sql) only after checking you do not already have a conflicting table.

## 2. Track in Hasura

**Data** → `public.media_assets` → **Track** (if untracked).

After schema changes: **Data** → `media_assets` → **Modify** → **Reload** or untrack/retrack so GraphQL exposes all columns (especially `id`, `s3_key`, `s3_bucket`).

## 3. Permissions (role `user`, JWT)

**Select** — filter `{ uploaded_by_user_id: { _eq: X-Hasura-User-Id } }`  
Columns: `id`, `public_url`, `content_type`, `original_filename`, `size_bytes`, `created_at`

**Insert / update / delete** — none for `user` (writes go through `POST upload/image` with admin secret).

## 4. Secrets & storage

- `MEDIA_STORAGE_BUCKET=tasty-bucket` in Nhost Dashboard secrets
- Create `tasty-bucket` with **public download** enabled

## Troubleshooting

| Error | Fix |
|-------|-----|
| `field 'uuid' not found in type: 'media_assets'` | Deploy latest functions (`mediaAssetsCatalog.ts` uses `id`, not `uuid`) |
| `field 'media_assets' not found` | Track table in Hasura |
| `field 'storage_file_id' not found` | Same — use latest functions; legacy schema uses `s3_key` |
| `Failed to save media catalog entry` | Check NOT NULL columns (`s3_key`, `sha256`, `size_bytes`, `content_type`) and admin secret |

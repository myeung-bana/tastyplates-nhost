# Hasura setup — `public.media_assets`

1. Run SQL: [`migrations/add_media_assets.sql`](./migrations/add_media_assets.sql)
2. In Hasura Console: **Data** → track `public.media_assets`
3. Permissions for role `user` (JWT):

**Select** — filter `{ uploaded_by: { _eq: X-Hasura-User-Id } }`  
Columns: `uuid`, `public_url`, `content_type`, `original_name`, `file_size`, `created_at`

**Insert / update / delete** — none for `user` (writes go through `POST upload/image` only).

4. Dashboard secrets: `MEDIA_STORAGE_BUCKET=tasty-bucket`, ensure Storage bucket exists with public download for display URLs.

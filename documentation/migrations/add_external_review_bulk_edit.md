# Migration: external review bulk edit (versioning + audit)

Run [`add_external_review_bulk_edit.sql`](./add_external_review_bulk_edit.sql) in Nhost Dashboard → Database → SQL Editor.

## Hasura

1. Track `external_review_edit_batches`
2. Track `external_review_edit_batch_items`
3. Track function `apply_external_review_edit_batch` as a mutation (admin/service role only)
4. Ensure `restaurant_external_reviews` exposes `edit_version` and `updated_at`

## Verify

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'restaurant_external_reviews'
  AND column_name IN ('edit_version', 'updated_at');
```

After migration, use **External Reviews → Bulk Editor** in the admin portal or MCP `export_external_reviews` / `preview_external_review_bulk_edit` / `apply_external_review_bulk_edit`.

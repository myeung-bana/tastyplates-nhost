# Migration: `restaurant_external_reviews`

Run [`add_restaurant_external_reviews.sql`](./add_restaurant_external_reviews.sql) in Nhost Dashboard → Database → SQL Editor.

## Hasura

1. **Data → public → restaurant_external_reviews → Track**
2. Permissions:
   - `public` / `user`: no access
   - Service role / admin Functions: full access via `NHOST_ADMIN_SECRET`

## Functions

Deploy Nhost Functions after migration:

- `external-reviews/ingest`
- `external-reviews/rebuild-summary`
- `external-reviews/list`
- `external-reviews/flag`
- `external-reviews/get-combined-summary`

## Verify

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'restaurant_external_reviews'
ORDER BY ordinal_position;
```

# Migration: `restaurant_palate_rating_summary`

Run [`add_restaurant_palate_rating_summary.sql`](./add_restaurant_palate_rating_summary.sql) in Nhost Dashboard → Database → SQL Editor.

## Hasura

1. **Data → public → restaurant_palate_rating_summary → Track**
2. Track views:
   - `palate_leaf_to_parent`
   - `restaurant_palate_rating_summary_combined`
   - `restaurant_palate_rating_effective`
3. Permissions:
   - `public` / `user`: select on aggregate columns only
   - Admin/service role: full access for rebuild functions

## Verify

```sql
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'restaurant_palate_rating_summary',
    'palate_leaf_to_parent',
    'restaurant_palate_rating_summary_combined',
    'restaurant_palate_rating_effective'
  );
```

## After migration

Run a palate rebuild for one restaurant from the admin portal **Performance Overview → Rebuild palate ratings**, or via MCP `rebuild_palate_rating_summary`.

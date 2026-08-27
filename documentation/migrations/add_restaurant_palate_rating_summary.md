# Migration: `restaurant_palate_rating_summary`

For a new installation, run
[`add_restaurant_palate_rating_summary.sql`](./add_restaurant_palate_rating_summary.sql) in Nhost
Dashboard → Database → SQL Editor.

If the original migration was already applied when it referenced `restaurant_palates`, run
[`fix_palate_rating_summary_cuisine_taxonomy.sql`](./fix_palate_rating_summary_cuisine_taxonomy.sql)
instead. It discards the derived summary rows and recreates them against `restaurant_cuisines`.
After it runs, remove the obsolete tracked `palate_leaf_to_parent` view from Hasura metadata,
reload metadata, and track `cuisine_leaf_to_parent`.

## Hasura

1. **Data → public → restaurant_palate_rating_summary → Track**
2. Track views:
   - `cuisine_leaf_to_parent`
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
    'cuisine_leaf_to_parent',
    'restaurant_palate_rating_summary_combined',
    'restaurant_palate_rating_effective'
  );
```

## After migration

Reload Hasura metadata after the corrective migration, then run a palate rebuild for one
restaurant from the admin portal **Performance Overview → Rebuild palate ratings**, or via MCP
`rebuild_palate_rating_summary`. Existing summaries cannot be retained because their IDs referred
to the flavor taxonomy.

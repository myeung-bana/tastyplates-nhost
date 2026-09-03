# Migration: external review bulk edit (versioning + audit)

Promoted to `nhost/migrations/default/1788480000000_add_external_review_bulk_edit/`, so a Git
deploy applies it automatically. [`add_external_review_bulk_edit.sql`](./add_external_review_bulk_edit.sql)
holds the same DDL for manual runs in Nhost Dashboard → Database → SQL Editor.

## Already ran an earlier version of this migration?

Re-apply it. The first revision declared `apply_external_review_edit_batch` as `RETURNS jsonb`,
which **Hasura cannot track** — it only exposes functions that return a tracked table, so the
mutation never appeared and Apply failed with:

```
field 'apply_external_review_edit_batch' not found in type: 'mutation_root'
```

The function now returns `SETOF public.external_review_edit_batches`. The migration drops the old
signature first, because Postgres rejects a return-type change via `CREATE OR REPLACE`.

## Hasura

Track in this order — the function returns `SETOF external_review_edit_batches`, so that table must
be tracked first:

1. Track table `external_review_edit_batches`
2. Track table `external_review_edit_batch_items`
3. Track function `apply_external_review_edit_batch` (Data → public → Untracked functions). It is
   `VOLATILE`, so Hasura exposes it as a **mutation**.
4. Confirm `restaurant_external_reviews` exposes `edit_version` and `updated_at` — reload metadata
   if the columns are missing from the GraphQL schema.

The `admin` role needs no explicit function permission; admin sees every tracked object. If the
function is missing from `mutation_root` while tracked tables work, it is not tracked yet.

## Verify

Columns:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'restaurant_external_reviews'
  AND column_name IN ('edit_version', 'updated_at');
```

Function return type (must be `external_review_edit_batches`, not `jsonb`):

```sql
SELECT p.proname,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)    AS returns
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'apply_external_review_edit_batch';
```

Once tracked, `apply_external_review_edit_batch` appears in GraphiQL under `mutation` and returns
batch rows:

```graphql
mutation {
  apply_external_review_edit_batch(
    args: { p_batch_id: "<preview-batch-uuid>", p_confirm_changed_count: 1, p_admin_user_id: "<admin>" }
  ) {
    id status applied_count applied_at failure_message
  }
}
```

## Rollback

`down.sql` drops the function, both audit tables, and the two review columns. Untrack all three in
Hasura first. It destroys bulk-edit audit history.

## Usage

**External Reviews → Bulk Editor** in the admin portal, or MCP `export_external_reviews` /
`preview_external_review_bulk_edit` / `apply_external_review_bulk_edit`.

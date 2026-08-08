# Migration: `restaurant_external_review_summary`

Run after [`add_restaurant_external_reviews.sql`](./add_restaurant_external_reviews.sql).

Run [`add_restaurant_external_review_summary.sql`](./add_restaurant_external_review_summary.sql) in Nhost Dashboard → SQL Editor.

## Hasura

1. Track `restaurant_external_review_summary`
2. Optional public `select` on aggregate columns only (no raw review fields on this table)

## Verify

```bash
curl "$FUNCTIONS_URL/v1/external-reviews/rebuild-summary" \
  -X POST \
  -H "x-admin-secret: $NHOST_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}'
```

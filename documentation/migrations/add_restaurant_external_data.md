# Migration: `restaurant_external_data`

## Apply SQL

Run [`add_restaurant_external_data.sql`](./add_restaurant_external_data.sql) in Nhost Dashboard → Database → SQL Editor.

## Hasura Console

1. **Data → public → restaurant_external_data → Track**
2. **Permissions**
   - No `user` / `public` select in v1 (admin-only via Nhost functions + admin secret)
   - If you add an `admin` role later: select/insert/update on this table only — do not grant write on `restaurant_reviews`

## Nhost function secrets

Add in Nhost Dashboard → Settings → Secrets:

| Secret | Purpose |
|--------|---------|
| `APIFY_TOKEN` | Apify API token |
| `APIFY_GOOGLE_ACTOR_ID` | Actor ID for Google Maps scrape (e.g. `compass/crawler-google-places`) |
| `APIFY_WEBHOOK_SECRET` | Shared secret verified on `admin/apify-webhook` |
| `NHOST_FUNCTIONS_PUBLIC_URL` | Optional override; default `https://{subdomain}.functions.{region}.nhost.run/v1` |

## Verify

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'restaurant_external_data'
ORDER BY ordinal_position;
```

## Endpoints (after function deploy)

- `POST /v1/admin-api/trigger-external-scrape` — MCP Bearer, admin JWT, or `x-admin-secret`
- `POST /v1/admin/apify-webhook` — header `x-apify-webhook-secret`
- `GET /v1/admin-api/get-external-data?restaurant_uuid=...` — MCP Bearer, admin JWT, or `x-admin-secret`

The business portal proxies these via `/api/v1/external-data/*` (session auth → Nhost `admin-api/*`).

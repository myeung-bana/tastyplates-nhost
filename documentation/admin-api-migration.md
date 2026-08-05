# Admin API migration (Option B)

Move the HTTP admin API that MCP and tooling call from Netlify (`tasty-business-portal/app/api/v1/*`) to Nhost Functions (`admin-api/*`), while keeping the portal routes during migration.

## Architecture

```text
Claude Desktop / Cursor
  → tastyplates-admin-mcp (local stdio, npm package)
  → Nhost Functions /v1/admin-api/*
  → Hasura / Postgres

Admin UI (browser)
  → tasty-business-portal /api/v1/*  (unchanged until Phase 5 deprecation)

Legacy jobs / webhooks
  → admin/* (Apify webhook, backfills — x-admin-secret / webhook secret only)

Portal external-data proxy + MCP
  → admin-api/get-external-data, admin-api/trigger-external-scrape
```

MCP stays a **local stdio package**. Only the HTTP API moves to Nhost.

## Phases

| Phase | Status | Scope |
|-------|--------|--------|
| 0 | Done | `_lib/` auth, SQL, MCP keys, respond, places, quality |
| 1 | Done | Handler libs + `functions/admin-api/*` entry points |
| 2 | Done | `mcp-keys`, `revoke-mcp-key`, `mcp-config`, `mcp-health` |
| 3 | Done | `tastyplates-admin-mcp` paths → `/admin-api/*` |
| 4 | Partial | Portal `mcp-config` feature flag; UI still on portal API |
| 5 | Future | Deprecate portal `app/api/v1` after MCP + UI validated |

## Nhost function endpoints

Base URL: `https://<subdomain>.functions.<region>.nhost.run/v1`

| Function | Method | Auth |
|----------|--------|------|
| `admin-api/get-restaurants` | GET | MCP / admin JWT / x-admin-secret |
| `admin-api/get-restaurant-by-id?uuid=` | GET | same |
| `admin-api/create-restaurant` | POST | same |
| `admin-api/update-restaurant` | PUT/POST | same |
| `admin-api/create-restaurant-from-place` | POST | same |
| `admin-api/places-search` | GET | same |
| `admin-api/places-details` | GET | same |
| `admin-api/get-reviews` | GET | same |
| `admin-api/get-review-by-id?id=` | GET | same |
| `admin-api/update-review` | PUT/POST | same |
| `admin-api/get-cuisines` | GET | same |
| `admin-api/get-categories` | GET | same |
| `admin-api/get-price-ranges` | GET | same |
| `admin-api/get-external-data` | GET | same |
| `admin-api/trigger-external-scrape` | POST | same |
| `admin-api/mcp-keys` | GET/POST | **admin JWT only** |
| `admin-api/revoke-mcp-key?id=` | DELETE | **admin JWT only** |
| `admin-api/mcp-config` | GET | **admin JWT only** |
| `admin-api/mcp-health` | GET | public |

**Removed duplicates:** `admin/get-restaurant-external-data` and `admin/trigger-apify-scrape` were consolidated into `admin-api/get-external-data` and `admin-api/trigger-external-scrape`. The business portal external-data proxy and MCP both use the `admin-api/*` paths.

**Still on `/admin/*` only:** `apify-webhook`, backfills, `update-restaurant`, `moderate-review`, `update-user-profile`, `migrate-media` (privileged / internal — not MCP surface).

## Auth

| Actor | Header |
|-------|--------|
| MCP (Claude) | `Authorization: Bearer tp_mcp_...` |
| Admin session | `Authorization: Bearer <Nhost JWT with admin role>` |
| Legacy / portal proxy | `x-admin-secret: <HASURA_GRAPHQL_ADMIN_SECRET>` |

MCP keys live in `public.admin_mcp_api_keys` (see `documentation/migrations/add_admin_mcp_api_keys.sql`).

## MCP setup (after Nhost deploy)

1. Deploy Nhost functions (git push to linked repo).
2. Set cloud secret `GOOGLE_MAPS_API_KEY` for places tools.
3. In Claude Desktop / Cursor config:

```json
{
  "mcpServers": {
    "tastyplates-admin": {
      "command": "node",
      "args": ["/path/to/tastyplates-admin-mcp/dist/index.js"],
      "env": {
        "TASTYPLATES_API_URL": "https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1",
        "TASTYPLATES_MCP_API_KEY": "tp_mcp_..."
      }
    }
  }
}
```

4. Generate an MCP key from the admin portal (Settings → MCP) or via `admin-api/mcp-keys` with admin JWT.

## Portal feature flag

In `tasty-business-portal/.env`:

```env
NEXT_PUBLIC_USE_NHOST_ADMIN_API=true
NEXT_PUBLIC_NHOST_FUNCTIONS_URL=https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1
```

When enabled, MCP config snippets in the portal UI point at Nhost instead of Netlify. The restaurant admin UI still uses `/api/v1/restaurants-v2/*` until Phase 5.

## Verify

```bash
# Health (no auth)
curl "https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1/admin-api/mcp-health"

# List restaurants (MCP key)
curl -H "Authorization: Bearer tp_mcp_..." \
  "https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1/admin-api/get-restaurants?limit=1"
```

## Do not yet

- Remove portal `app/api/v1/*` routes
- Bulk-import 1000+ restaurants via sequential MCP calls (plan batch function later)
- Publish `tastyplates-admin-mcp` to npm (use local `node dist/index.js`)

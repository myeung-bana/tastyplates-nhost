# Admin API migration (Option B)

> **Update (2026-08):** MCP HTTP surface moved back to the Netlify portal at `/api/mcp/*`. Nhost `admin-api/*` remains deployed for legacy/internal callers but is **deprecated for MCP**. See [`tasty-business-portal/documentation/admin-mcp.md`](../../tasty-business-portal/documentation/admin-mcp.md).

Move the HTTP admin API that MCP and tooling call from Netlify (`tasty-business-portal/app/api/v1/*`) to Nhost Functions (`admin-api/*`), while keeping the portal routes during migration.

## Current architecture (MCP)

```text
Claude Desktop / Cursor
  → tastyplates-admin-mcp (local stdio)
  → Netlify portal /api/mcp/*
  → Hasura / Postgres

Admin UI (browser)
  → tasty-business-portal /api/v1/*  (unchanged)

Legacy / internal
  → Nhost /v1/admin-api/*  (deprecated for MCP; external-data v1 proxy still uses some endpoints)
```

## Phases

| Phase | Status | Scope |
|-------|--------|--------|
| 0 | Done | `_lib/` auth, SQL, MCP keys, respond, places, quality |
| 1 | Done | Handler libs + `functions/admin-api/*` entry points |
| 2 | Done | `mcp-keys`, `revoke-mcp-key`, `mcp-config`, `mcp-health` on Nhost |
| 3 | Superseded | MCP briefly targeted Nhost `/admin-api/*` |
| 4 | **Done** | MCP on portal `/api/mcp/*`; key auth on same Hasura path as key creation |
| 5 | Future | Remove Nhost `admin-api/*` MCP duplicates; optional v1 deprecation |

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

## Portal environment

In `tasty-business-portal/.env` (and Netlify env vars):

```env
NEXT_PUBLIC_NHOST_SUBDOMAIN=ygmkmxorcapgpimwerpc
NEXT_PUBLIC_NHOST_REGION=ap-southeast-1
NEXT_PUBLIC_NHOST_FUNCTIONS_URL=https://ygmkmxorcapgpimwerpc.functions.ap-southeast-1.nhost.run/v1
```

The MCP settings page (`/dashboard/admin/settings/mcp`) builds Claude/Cursor config with  
`TASTYPLATES_API_URL` = Nhost functions base URL (via `getAdminApiUrl()`).  
Restaurant admin UI still uses `/api/v1/restaurants-v2/*` until Phase 5.

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

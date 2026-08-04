# Migration: `admin_mcp_api_keys`

## Apply SQL

Run [`add_admin_mcp_api_keys.sql`](./add_admin_mcp_api_keys.sql) in Nhost Dashboard → Database → SQL Editor.

## Hasura Console

1. **Data → public → admin_mcp_api_keys → Track** (optional — portal uses Hasura SQL API and works without GraphQL tracking)
2. **Permissions**
   - No `user` / `public` select or write in v1
   - Portal accesses this table only via `x-hasura-admin-secret` in server routes

## Verify

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'admin_mcp_api_keys'
ORDER BY ordinal_position;
```

## Related

- Portal MCP settings: `/dashboard/admin/settings/mcp`
- Auth: `tasty-business-portal/src/lib/require-api-auth.ts`
- Package: `tastyplates-admin-mcp/`

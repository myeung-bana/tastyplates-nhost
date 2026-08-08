# Incident Report: Tastyplates Admin MCP — `list_restaurants` Unauthorized Error

**Date of incident:** 2026-08-05
**Reported by:** Muser (6ixTech)
**Compiled by:** Claude
**Status:** Resolved — MCP migrated to portal `/api/mcp/*` (2026-08)

**Resolution:** MCP key auth failed on Nhost because key lookup used a separate Hasura SQL path from portal key creation. MCP now calls the Netlify portal at `/api/mcp/*`, using the same `mcp-api-keys.ts` auth as key management. Set `TASTYPLATES_API_URL` to the portal base URL (not Nhost functions).

---

## 1. Summary

Repeated calls to `tastyplates-admin:list_restaurants` via the Tastyplates Admin MCP connector return a bare `Unauthorized` error with no request ID, trace ID, or additional metadata. Backend logs on the Nhost/Hasura side, checked at matching timestamps, show **successful** responses — meaning the failure appears to occur **outside** the backend infrastructure that MCP tool is meant to be calling.

---

## 2. Timeline of Attempts

| # | Time (UTC) | Action | MCP Result | Correlated Backend Log |
|---|-----------|--------|-----------|------------------------|
| 1 | ~2026-08-05 (pre-15:20) | `list_restaurants(limit=5)` | `Unauthorized` (no metadata) | None checked yet |
| 2 | ~2026-08-05 (pre-15:20) | `list_restaurants(limit=5)` | `Unauthorized` (no metadata) | None checked yet |
| 3 | ~15:20:51 | `list_restaurants(limit=5)` | `Unauthorized` | Nhost `/admin-api/get-restaurants` → `"status": "success"`, 352 bytes, invocationId `2b42e32f-16b5-4a3e-9c46-ee2ab625f0de` |
| 4 | ~15:45–15:47 | `list_restaurants(limit=5)` | `Unauthorized` | Hasura `/v1/graphql` → `parse-failed`, `key "query" not found`, HTTP 200, request_id `15b5b10ddf9af1182718682a48292bcf` |
| 5 | ~15:47:01–15:47:02 | `list_restaurants(limit=5)` | `Unauthorized` | **Both** logs present at matching timestamp:<br>• Hasura `parse-failed`, request_id `334822394e89b706fb2e0d7f037f5a78`<br>• Nhost `/admin-api/get-restaurants` → success, invocationId `a56f9d4e-9e94-4370-aa57-c915ae9e88c9` |
| 6 | ~15:47+ | `list_restaurants(limit=5)` | `Unauthorized` | Not yet checked against logs |

**Key observation:** Attempt #5 shows the closest timing correlation — both a Hasura parse error and a successful Nhost function invocation landed within ~1 second of the MCP tool call. Despite this, the MCP tool still reported `Unauthorized` to Claude.

---

## 3. Layers Involved (for review, outside-in)

Use this as a checklist — work through each layer and mark what you've confirmed.

### Layer 1: MCP Client / Claude Tool Call
- [ ] Confirm the exact parameters Claude's `list_restaurants` call sends (currently: `{"limit": 5}`)
- [ ] Confirm whether the MCP tool schema expects additional/different parameters than what's being sent
- **Note:** Claude has no visibility into what the MCP connector does internally after the call is made — this is a blind spot for this report.

### Layer 2: MCP Connector (Tastyplates Admin Portal — `tastyplates-business-portal.netlify.app`)
- [ ] Check the connector's own outbound request logs (not Nhost's) for the timestamps above
- [ ] Verify what credential/token the connector is configured to use when calling the backend
- [ ] Check token expiry, scope, and environment (staging vs. production)
- [ ] Confirm the connector is constructing a well-formed GraphQL request body (see Layer 3 — the `parse-failed` error suggests a malformed `query` key may originate here)
- [ ] Check whether the connector is catching a downstream error (e.g., the Hasura parse-failed) and mapping it incorrectly to a generic "Unauthorized" response back to Claude

### Layer 3: Hasura GraphQL Endpoint (`/v1/graphql`)
- [ ] Investigate `parse-failed` errors: `key "query" not found` — this means a POST body arrived without a `query` field
- [ ] Determine whether this malformed request is coming from the MCP connector itself, or a separate/unrelated caller hitting the same endpoint around the same time
- [ ] Note: `user_vars` shows `x-hasura-role: admin` — meaning auth succeeded at this layer; the request was authenticated but malformed
- [ ] Cross-reference request_ids (`15b5b10ddf9af1182718682a48292bcf`, `334822394e89b706fb2e0d7f037f5a78`) against any request logging on the connector side to confirm origin

### Layer 4: Nhost Function (`/admin-api/get-restaurants`)
- [ ] Confirm this function is the intended handler for `list_restaurants`
- [ ] Function reports clean `success` status and consistent response size (352 bytes) on every checked attempt — infrastructure health here is not in question
- [ ] Confirm whether this function's success response is what should be returned to the MCP connector, and whether the connector is correctly parsing/forwarding it

### Layer 5: Network / Gateway (if any exists in front of the connector or Hasura)
- [ ] Check for any API gateway, reverse proxy, or IP allowlist between the MCP connector and Hasura/Nhost
- [ ] Source IP in Hasura logs: `18.142.181.158` — confirm this is the expected origin for the MCP connector's outbound calls

---

## 4. What We Know vs. What's Unconfirmed

**Confirmed:**
- Nhost function `/admin-api/get-restaurants` is healthy and returning success consistently.
- Hasura is authenticating requests as `admin` role successfully (auth is not failing at this layer).
- A malformed GraphQL request (`parse-failed`, missing `query` key) is occurring, timed closely with at least one MCP call attempt.
- The MCP tool call from Claude's side fails identically every time — no variation in error message, no metadata, no partial success.

**Not yet confirmed:**
- Whether the `parse-failed` Hasura request and the `Unauthorized` MCP response are literally the same request, or two separate/coincidentally-timed events.
- What credential or token the MCP connector uses, and whether it's valid/expired/misscoped.
- Whether the connector is even reaching Hasura/Nhost at all for the calls that returned "Unauthorized" with no matching log (attempts #1, #2, #6).
- Any logs from the MCP connector itself — this report has zero visibility into that layer, which is currently the most likely candidate for the root cause.

---

## 5. Suggested Next Steps (Priority Order)

1. **Pull logs directly from the Tastyplates Admin MCP connector** (the Netlify-hosted portal) — this is the missing link. Check both inbound (from Claude) and outbound (to Hasura/Nhost) request logs.
2. **Inspect the connector's auth configuration** — token source, expiry, and how it's injected into outbound requests.
3. **Reproduce the `parse-failed` error in isolation** — manually send a GraphQL request via the connector's code path (or a copy of it) and inspect the actual request body being sent to `/v1/graphql`.
4. **Add request correlation IDs** if possible — right now there's no way to definitively match a Claude-initiated MCP call to a specific backend log line beyond timestamp proximity.
5. Once the connector's own logs are available, re-run this same MCP call and diff its outbound request against a known-good manual GraphQL query to Hasura.

---

## 6. Open Questions for the Team

- Does the MCP connector wrap Hasura/Nhost calls, or does it call some other intermediary first?
- Is `x-hasura-role: admin` being set by the connector itself, or inherited from a service account / JWT it's presenting?
- Are the `parse-failed` requests unique to this incident, or a pre-existing/ongoing issue unrelated to the MCP connector (worth checking Hasura logs over a longer time window, independent of these MCP call attempts)?
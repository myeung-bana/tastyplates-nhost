# Decouple migration — `tastyplates-backend` → single Nhost project

This document summarizes **what to do** and a **standard structure** for consolidating API-related work from **`tastyplates-backend`** into the **Nhost-linked repository** (`tastyplates-nhost` today, or a renamed canonical repo). The goal is one Git-connected Nhost project that owns **auth emails, Hasura metadata, migrations, and Functions**, so the web app can stay **static** and talk only to Nhost (Hasura + Auth + Functions URLs).

---

## 1. Why consolidate

| Today | Problem |
|-------|---------|
| **`tastyplates-nhost`** | GitHub-linked; holds **`nhost/emails/`** only. |
| **`tastyplates-backend`** | Holds **`functions/`**, **`nhost/metadata/`**, **`nhost/migrations/`**, optional **root Express + Nhost Run** (`nhost.toml`). |

Nhost’s Git integration expects **one repository** to be the **source of truth** for everything the platform deploys from Git: config, migrations, metadata, functions, and **email templates** under `nhost/emails/`. Two repos create drift, double PRs, and unclear ownership of “which repo is production.”

**Industry-standard outcome:** one repo (often named after the product or `backend`) with a single `nhost/` tree + `functions/` sibling, linked from the Nhost dashboard.

---

## 2. Target repository layout (standard)

Use this as the **end state** (names can stay `tastyplates-nhost` or you rename the repo to `tastyplates-backend` after merge—what matters is the **tree**):

```text
<canonical-nhost-repo>/
├── nhost/
│   ├── nhost.toml              # Hasura, Auth, Functions runtime, roles, etc.
│   ├── migrations/             # SQL migrations (source of truth for schema)
│   ├── metadata/               # Hasura permissions, relationships (tables.yaml + tables/)
│   └── emails/                 # Auth email templates (already in tastyplates-nhost)
│
├── functions/                  # Nhost Functions (TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── _lib/               # Shared: hasura client, redis, auth, validate, graphql strings
│       ├── <domain>/           # e.g. reviews/, users/, restaurants/, uploads/, admin/
│       ├── server.ts           # optional: local standalone Express (dev only)
│       ├── env-load.ts         # optional: dotenv for standalone
│       └── routes/             # optional: /healthz, /docs for local server
│
├── documentation/              # optional: runbooks, this file, links to client migration
└── README.md                   # how to nhost up, deploy, env vars
```

**Optional** (only if you still need a long-running Node process):

```text
├── nhost.toml                  # Nhost Run: [[run.services]] → Express on port 4000
├── package.json                # root Express service
├── src/                        # Express entry + routes (keep thin; prefer Functions + Hasura)
└── Dockerfile
```

**Rule of thumb:** put **simple CRUD** behind **Hasura** + RLS; put **uploads, rate limits, Redis composition, admin batch jobs** in **Functions**; use **Run (Express)** only for workloads that truly need one always-on process (WebSockets, legacy router, etc.).

---

## 3. What you have in `tastyplates-backend` (migration map)

| Source in `tastyplates-backend` | Destination in canonical Nhost repo |
|--------------------------------|----------------------------------------|
| `nhost/nhost.toml` | Merge into **`nhost/nhost.toml`** (resolve duplicates with root `nhost.toml`—pick one deployment story: Run vs Functions-only). |
| `nhost/migrations/` | **`nhost/migrations/`** — copy SQL; keep linear history. |
| `nhost/metadata/` | **`nhost/metadata/`** — tables, permissions, `tables.yaml`. |
| `functions/` | **`functions/`** — entire workspace (handlers + `_lib/`). |
| `documentation/*.md` | Either **`documentation/`** in canonical repo or link from README. |
| Root **`src/`** Express + root **`nhost.toml` Run** | **Decide:** port remaining routes into **Functions** or **Hasura**, then **remove** Run; or keep Run and document which URLs hit Run vs Functions. |
| `tastyplates-nhost/nhost/emails/` | **`nhost/emails/`** in the same repo as migrations + functions (no separate email-only repo). |

Detailed route and GraphQL mapping for clients lives in **`tastyplates-backend/documentation/client-integration.md`** (keep a copy or symlink in the canonical repo after merge).

---

## 4. Migration checklist (ordered)

### Phase A — Repository strategy

1. **Choose the canonical repo** that Nhost Git will track (recommended: expand **`tastyplates-nhost`** to include full `nhost/` + `functions/`, *or* point Nhost at **`tastyplates-backend`** and move **`nhost/emails/`** there—pick one).
2. **Freeze** the non-canonical repo or mark it read-only after cutover.
3. Update **Nhost dashboard → Git** to the canonical repo and branch; set correct **root path** if the Nhost project lives in a subfolder of a monorepo.

### Phase B — Nhost config and data plane

4. Copy **`nhost.toml`**, **`migrations/`**, **`metadata/`** into canonical **`nhost/`**.
5. Run **`nhost up`** locally; apply migrations; verify Hasura console matches metadata.
6. Copy **`nhost/emails/`** from `tastyplates-nhost` into the same **`nhost/emails/`** if the canonical repo was previously backend-only.

### Phase C — Functions (API surface)

7. Copy **`functions/`** wholesale (or `git subtree` / one-time merge).
8. In Nhost Cloud, set **secrets** for Functions: Hasura admin URL/secret, JWT verification, S3, Upstash Redis, etc. (mirror `functions/.env.local.example` from backend—do not commit secrets).
9. Deploy Functions; smoke-test each **`/v0/<path>`** from staging.

### Phase D — Optional Express / Run

10. If root Express in `tastyplates-backend` still serves routes **duplicated** in Functions, **remove duplicates** and point clients to Functions only.
11. If Run is **no longer needed**, delete root **`nhost.toml` Run` block** and root **`src/`** Express app from the canonical repo to reduce operational surface.

### Phase E — Frontend decouple

12. In **`tastyplates-v2-1`**, set **`NEXT_PUBLIC_API_MODE=nhost`** and env URLs for Hasura + Functions (see **`tastyplates-backend/documentation/client-integration.md`**).
13. Remove or gate legacy **`/api/v1/**`** routes only after traffic is verified on Nhost.
14. Enable **static export** (or equivalent) for web/native once no build-time dependency on Next API routes remains.

### Phase F — Cleanup

15. Archive **`tastyplates-nhost`** as a standalone repo **or** archive **`tastyplates-backend`**—whichever is **not** canonical.
16. Update **README**, **CI**, and **on-call runbooks** with one repo URL and one deploy path.

---

## 5. How this modularizes the backend and keeps the frontend static

| Concern | Where it lives after migration |
|---------|--------------------------------|
| **Auth** | Nhost Auth (JWT); clients use Nhost client SDK. |
| **CRUD + lists** | Hasura GraphQL with row-level permissions. |
| **Heavy / privileged HTTP** | Nhost Functions (`functions/src/...`). |
| **HTML / PWA shell** | Static or SPA build; **no** server-side API routes required for core features. |

The **decouple** is: **browser or native app** → **Nhost endpoints only**; Next.js (or other) becomes a **static asset host** + client-side routing, not the system of record for API logic.

---

## 6. References (existing docs)

| Document | Location |
|----------|----------|
| Tech stack and `functions/` tree | `tastyplates-backend/documentation/tech-stack.md` |
| API conventions | `tastyplates-backend/documentation/api-bestpractice.md` |
| Old routes → GraphQL / Functions | `tastyplates-backend/documentation/client-integration.md` |
| Client-side migration notes | `tastyplates-v2-1/documentation/migration/nhost-client-migration.md` |

---

## 7. Success criteria

- [ ] One Git repo linked to Nhost contains **`nhost/`** (toml, migrations, metadata, **emails**) and **`functions/`**.
- [ ] Production clients use **Hasura URL + Functions base URL + Auth** only.
- [ ] No duplicate HTTP implementations for the same contract (Run vs Functions) unless explicitly transitional.
- [ ] Frontend can ship as **static export** (or equivalent) without depending on Next `/api` for migrated features.

---

*This file lives under **`tastyplates-nhost/documentation/`** as the high-level decouple plan; keep it updated when the canonical repository name or dashboard Git root changes.*

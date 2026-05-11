# tastyplates-nhost

Nhost-linked repository for Tastyplates: **Hasura / Auth / Postgres configuration**, **auth email templates**, and **Nhost Functions** using the standard root-level routing layout under `functions/`.

| Directory | Contents |
|-----------|----------|
| `nhost/nhost.toml` | Hasura, Auth, Postgres, Observability |
| `nhost/migrations/` | SQL migrations (schema source of truth) |
| `nhost/metadata/` | Hasura permissions and relationships |
| `nhost/emails/` | Auth email templates (verify, reset, OTP, etc.) |
| `functions/` | Deployable Nhost Functions and shared helpers |
| `documentation/` | Architecture and migration runbooks |

---

## Local development

Install the [Nhost CLI](https://docs.nhost.io/cli), then from the repo root:

```bash
nhost up
```

This starts Postgres, Hasura, Auth, Functions, and related services defined in `nhost.toml`.

---

## Deploying to Nhost Cloud

1. Push this repository to GitHub.
2. In the Nhost dashboard → **Git** → connect this repo and set the **root path** to `/` (or the monorepo subfolder if applicable).
3. Under **Settings → Secrets**, ensure the names referenced in `nhost/nhost.toml` exist (for example `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`, `GRAFANA_ADMIN_PASSWORD`).
4. Each push to the connected branch triggers a deployment.

---

## Documentation

- [Decouple migration plan](documentation/decouple-plan.md)

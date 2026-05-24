# tastyplates-nhost

Nhost-linked repository for Tastyplates: **Hasura / Auth / Postgres configuration**, **auth email templates**, and **Nhost Functions** using the standard root-level routing layout under `functions/`.

| Path | Contents |
|------|----------|
| `config.yaml` | Hasura CLI root (required for Nhost deploy metadata step) |
| `nhost/nhost.toml` | Hasura, Auth, Postgres, Observability |
| `nhost/metadata/` | Hasura permissions and relationships |
| `nhost/migrations/` | SQL migrations (`default/` may be empty for metadata-only deploys) |
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
3. Under **Settings → Secrets**, ensure the names referenced in `nhost/nhost.toml` exist:
   - `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`, `GRAFANA_ADMIN_PASSWORD`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (same Web OAuth client as the Next app; see `.secrets.example`)
4. In Google Cloud Console, set the OAuth redirect URI to  
   `https://ygmkmxorcapgpimwerpc.auth.ap-southeast-1.nhost.run/v1/signin/provider/google/callback`
5. Validate before deploy: `nhost config validate` (from this repo root; uses linked project secrets when logged in).
6. Each push to the connected branch triggers a deployment (**migrations**, **metadata**, **functions**, and `nhost.toml`).

### Hasura metadata (required for review feeds)

`nhost/metadata/` uses the standard Nhost layout (`databases/default/tables/public_*.yaml`). It includes the **`AuthorProfile`** relationship on `restaurant_reviews` (→ `user_profiles`), which review functions query and return to mobile as `AuthorProfile`.

If deploy logs show `cannot find [config.yaml]`, commit root **`config.yaml`** and set Git **Base directory** to `/` (standalone repo) or **`tastyplates-nhost`** (monorepo subfolder).

If the Following feed logs `field 'AuthorProfile' not found` or `field 'author' not found`, the relationship is missing or has the wrong name on cloud — Hasura relationship must be **`AuthorProfile`**. See [api-doc-v2.md](documentation/api-doc-v2.md) (Part 2).

See [documentation/api-doc-v2.md](documentation/api-doc-v2.md) (Hasura + operations), [api-guide.md](documentation/api-guide.md) (HTTP functions), and [nhost/migrations/README.md](nhost/migrations/README.md).

---

## Documentation

- [API & Hasura (v2)](documentation/api-doc-v2.md) — metadata, deploy, troubleshooting
- [Nhost Functions API guide](documentation/api-guide.md) — HTTP routes, auth, envelope
- [Decouple migration plan](documentation/decouple-plan.md)

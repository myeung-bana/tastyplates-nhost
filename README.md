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

`nhost/metadata/` uses the standard Nhost layout (`databases/default/tables/public_*.yaml`). It includes the **`author`** relationship on `restaurant_reviews` (→ `user_profiles`), which review functions query before enriching responses as `AuthorProfile`.

If deploy logs show `cannot find [config.yaml]`, commit root **`config.yaml`** and set Git **Base directory** to `/` (this repo root).

If the Following feed logs `field 'author' not found in type: 'restaurant_reviews'`, metadata has not been applied on cloud yet — verify deploy succeeded with `config.yaml` + `nhost/metadata/` on the branch.

See [documentation/hasura-metadata.md](documentation/hasura-metadata.md) and [nhost/migrations/README.md](nhost/migrations/README.md).

---

## Documentation

- [Decouple migration plan](documentation/decouple-plan.md)
- [Hasura metadata & migrations](documentation/hasura-metadata.md)

# tastyplates-nhost

The canonical Nhost backend for Tastyplates. This is the single repository linked to the Nhost dashboard — it owns all platform deployment artefacts:

| Directory | Contents |
|-----------|----------|
| `nhost/nhost.toml` | Hasura, Auth, Functions, Postgres, Observability config |
| `nhost/migrations/` | SQL migrations (schema source of truth) |
| `nhost/metadata/` | Hasura table permissions and relationships |
| `nhost/emails/` | Auth email templates (verify, reset, OTP, etc.) |
| `functions/` | Nhost Functions — TypeScript API handlers |
| `documentation/` | Architecture and migration runbooks |

---

## Local development

### Prerequisites

- [Node.js 22+](https://nodejs.org)
- [Nhost CLI](https://docs.nhost.io/cli) — `npm install -g nhost`
- An [Upstash Redis](https://upstash.com) database
- AWS S3 bucket + IAM credentials

### 1. Install dependencies

```bash
cd functions
npm install
```

### 2. Configure environment variables

```bash
cp functions/.env.example functions/.env.local
# Edit functions/.env.local and fill in all values
```

### 3a. Run against Nhost Cloud (recommended)

Point `NHOST_HASURA_URL` in `.env.local` at your cloud project, then:

```bash
cd functions
npm run dev:standalone
```

Endpoints are available at `http://localhost:3001/v0/...`

- Health UI: `http://localhost:3001/health/ui`
- Swagger docs: `http://localhost:3001/docs`

### 3b. Run fully local with `nhost up`

```bash
nhost up   # from repo root — starts Hasura, Auth, Postgres, Functions
```

Functions are deployed automatically on file change. The Nhost CLI proxy serves them at `http://localhost:1337/v1/functions/...`

---

## API endpoints

All functions are served under `/v0/` (local standalone) or `/v1/functions/` (Nhost CLI / cloud):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/uploads/image` | Upload + Sharp-process single image → S3 |
| POST | `/v0/uploads/batch` | Batch upload images → S3 |
| POST | `/v0/images/download-google-photo` | CORS proxy for Google Places photos |
| POST | `/v0/reviews/create` | Create a review (rate-limited) |
| POST | `/v0/reviews/create-comment` | Add a comment to a review |
| PUT | `/v0/reviews/update` | Update a review |
| DELETE | `/v0/reviews/delete` | Soft-delete a review |
| GET | `/v0/reviews/following-feed` | Paginated following feed (Redis-cached) |
| GET | `/v0/users/me` | Authenticated user profile |
| POST | `/v0/users/follow` | Follow a user |
| POST | `/v0/users/unfollow` | Unfollow a user |
| GET | `/v0/users/suggested` | Suggested users to follow |
| DELETE | `/v0/users/delete` | Delete own account |
| GET | `/v0/restaurants/search` | Search/filter restaurants (Redis-cached) |
| POST | `/v0/restaurants/match` | Match restaurant by Place ID / name / coords |
| POST | `/v0/admin/backfill-rating-summary` | Rebuild all rating summaries (admin) |
| GET | `/v0/admin/monitoring` | Redis version snapshot + config status (admin) |

---

## Deploying to Nhost Cloud

1. Push this repository to GitHub.
2. In the Nhost dashboard → **Git** → connect this repo and set the **root path** to `/` (or the subfolder if it's a monorepo).
3. Add all secrets under **Settings → Secrets**:
   - `GRAPHQL_ADMIN_SECRET`
   - `HASURA_GRAPHQL_JWT_SECRET`
   - `NHOST_WEBHOOK_SECRET`
   - `GRAFANA_ADMIN_PASSWORD`
4. Add all environment variables under **Settings → Environment Variables** (mirror `functions/.env.example`).
5. Every push to the connected branch triggers an automatic deployment.

---

## Environment variables reference

See `functions/.env.example` for the full list with descriptions.

Key variables:

| Variable | Used by |
|----------|---------|
| `NHOST_HASURA_URL` | All Hasura queries/mutations |
| `GRAPHQL_ADMIN_SECRET` | Admin-level Hasura access |
| `NHOST_AUTH_URL` | Token verification |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Caching and rate limiting |
| `S3_*` | Image uploads |

---

## Documentation

- [Decouple migration plan](documentation/decouple-migration.md) — why this repo is the canonical backend
- [API best practices](../tastyplates-backend/documentation/api-bestpractice.md)
- [Client integration guide](../tastyplates-backend/documentation/client-integration.md)

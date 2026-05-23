# Hasura metadata & migrations (Nhost standard)

This repo follows the [Nhost project layout](https://docs.nhost.io/platform/cli/local-development/):

```
config.yaml           # Hasura CLI root (committed — required for Nhost deploy metadata step)
nhost/
  nhost.toml
  metadata/          # Hasura API schema, permissions, relationships
  migrations/        # Postgres schema (can be empty default/ for metadata-only deploy)
  emails/
```

Metadata was synced from `Repo/metadata` in the monorepo. **Do not** use the legacy flat `tastyplates-backend/nhost/metadata/tables/` layout.

## Critical relationship for review functions

`restaurant_reviews.author_id` → `user_profiles.user_id` is exposed in GraphQL as **`author`**:

- File: `nhost/metadata/databases/default/tables/public_restaurant_reviews.yaml`
- Nested: `author { user_id username palates user { avatarUrl email displayName } }`

Nhost Functions query `author` and map the result to **`AuthorProfile`** in JSON responses (`functions/_lib/review-enrichment.ts`). Mobile clients read **`AuthorProfile`**, not `author`.

`user_profiles` → `auth.users` is relationship **`user`** (`public_user_profiles.yaml`).

## Local

From `tastyplates-nhost` (linked project):

```bash
nhost up
```

Applies pending migrations under `nhost/migrations/default/` and loads `nhost/metadata/`.

## Cloud deploy

1. Commit and push **`config.yaml`** (repo root), **`nhost/metadata/`**, and **`nhost/migrations/`** (empty `default/` is OK for metadata-only).
2. Nhost dashboard → Git → **Base directory** = `/` when this repository root is `tastyplates-nhost`.
3. Push triggers deploy: `nhost.toml` → migrations → **metadata** → functions.
4. In Hasura Console → **Data** → `restaurant_reviews` → **Relationships**: confirm **`author`** exists.

If deploy logs show `cannot find [config.yaml]`, the build commit is missing root `config.yaml` or the Base directory points at the wrong folder.

## Migrations caution

See `nhost/migrations/README.md`. SQL migrations are **not** in `default/` yet (metadata-only). Before adding FK retarget migrations from `Repo/migrations/`, complete preflight in `final-deprecation-migration.md` §E-2.

## Updating metadata

1. Edit YAML under `nhost/metadata/databases/default/tables/`.
2. Test locally with `nhost up`.
3. Push to deploy.

Keep `Repo/metadata` in the monorepo aligned when you change tables in either place.

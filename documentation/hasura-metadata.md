# Hasura metadata & migrations (Nhost standard)

This repo follows the [Nhost project layout](https://docs.nhost.io/platform/cli/local-development/):

```
nhost/
  nhost.toml
  metadata/          # Hasura API schema, permissions, relationships
  migrations/        # Postgres schema (applied on deploy / nhost up)
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

1. Commit and push `nhost/metadata/` and `nhost/migrations/` with your functions changes.
2. Nhost Git deploy applies **migrations** then **metadata** to the linked project.
3. In Hasura Console → **Data** → `restaurant_reviews` → **Relationships**: confirm **`author`** exists.
4. In GraphiQL, introspect `restaurant_reviews` fields — `author` should be listed.

## Migrations caution

See `nhost/migrations/README.md`. Before FK retarget migrations run on production, complete the orphan-ID preflight queries documented there (from `final-deprecation-migration.md` §E-2).

Held migrations under `migrations/held/` are **not** applied automatically.

## Updating metadata

1. Edit YAML under `nhost/metadata/databases/default/tables/`.
2. Test locally with `nhost up`.
3. Push to deploy.

Keep `Repo/metadata` in the monorepo aligned when you change tables in either place.

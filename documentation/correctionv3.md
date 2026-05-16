# Fix: `nhost/metadata` Structure is Missing `databases.yaml`

## What you noticed is correct

The `config.yaml` fatal error is caused by the Hasura CLI being invoked during
deploy to apply metadata — and it only gets invoked that way when Nhost's own
metadata pipeline cannot find a valid metadata structure to apply. The missing
piece is inside `nhost/metadata/databases/`.

---

## The structural difference between your working commit and now

Commit `0fd0451` only changed four documentation files. That means the metadata
structure that was deploying successfully was already committed before that point.
The deploy started failing in a **later commit** that touched `nhost/metadata/`.

The Hasura metadata format (config v3) requires this exact layout inside
`nhost/metadata/databases/`:

```
nhost/metadata/
├── version.yaml                         ← must contain: version: 3
└── databases/
    ├── databases.yaml                   ← THE MISSING FILE
    └── default/
        └── tables/
            ├── tables.yaml              ← index of tracked tables
            └── public_<table>.yaml      ← one per tracked table
```

**`databases/databases.yaml` is the critical file** that tells Hasura which
databases exist and how to connect to them. Without it, Hasura cannot apply
metadata at all, falls back to the raw CLI, and the CLI looks for `config.yaml`.

---

## What the current broken structure looks like

Based on the repo's current state, the `databases/` folder either:

- Has a subfolder named something other than `default` (e.g. `default_database`,
  or a custom database name), **without** a `databases.yaml` at the
  `databases/` level to declare it, **or**
- Is missing `databases.yaml` entirely — the folder exists but only contains the
  `default/` subfolder with no entry-point file

Either way, Hasura's metadata reader walks into `databases/`, finds no
`databases.yaml`, and cannot determine what database to connect to.

---

## The fix — three files to create or correct

### File 1: `nhost/metadata/databases/databases.yaml`

This file must exist at the `databases/` level. It declares the `default`
Postgres database and points to the tables index.

```yaml
- name: default
  kind: postgres
  configuration:
    connection_info:
      use_prepared_statements: false
      database_url:
        from_env: PG_DATABASE_URL
      isolation_level: read-committed
  tables: "!include default/tables/tables.yaml"
  functions: "!include default/functions/functions.yaml"
```

> `PG_DATABASE_URL` is automatically injected by Nhost — you do not set this
> manually. Nhost wires the Postgres connection string into this env var at
> runtime for the `default` database.

---

### File 2: `nhost/metadata/databases/default/tables/tables.yaml`

This is the index of all tracked tables. If you have no custom tables tracked
yet (Nhost auto-tracks `auth.*` and `storage.*` separately), this can be an
empty list:

```yaml
[]
```

If you have tables tracked (e.g. `public.restaurants`, `public.restaurant_reviews`),
each one must be listed:

```yaml
- "!include public_restaurants.yaml"
- "!include public_restaurant_reviews.yaml"
- "!include public_restaurant_users.yaml"
- "!include public_user_profiles.yaml"
- "!include public_restaurant_user_follows.yaml"
- "!include public_restaurant_rating_summary.yaml"
```

---

### File 3: `nhost/metadata/databases/default/functions/functions.yaml`

Required if `databases.yaml` includes a `functions` include. If you have no
tracked Postgres functions, this can be an empty list:

```yaml
[]
```

---

### File 4: `nhost/metadata/version.yaml`

Must exist with exactly this content:

```yaml
version: 3
```

---

## Do you need to create an additional database?

**No.** You do not need a second database. Nhost always uses `default` as the
single Postgres database name. The confusion comes from the folder being named
`default/` — that is not a database you create, it is a fixed name Nhost and
Hasura use for your single managed Postgres instance.

The `databases.yaml` file simply **declares** that database so Hasura knows it
exists and where to find its tables.

---

## What the correct full structure looks like

```
nhost/
├── nhost.toml
├── migrations/
│   └── default/
│       └── <timestamp>_init/
│           └── up.sql
└── metadata/
    ├── version.yaml                          ← version: 3
    └── databases/
        ├── databases.yaml                    ← declares the default DB ← ADD THIS
        └── default/
            ├── tables/
            │   ├── tables.yaml              ← [] or list of !include
            │   └── public_restaurants.yaml  ← one per tracked table
            └── functions/
                └── functions.yaml           ← [] if no tracked functions
```

---

## How to restore this from your cloud project (recommended)

Rather than manually recreating these files, pull the exact state from your
connected Nhost cloud project — this guarantees the structure matches what
Nhost expects for your specific project:

```bash
# From the repo root
nhost login
nhost link              # select your tastyplates project
nhost config pull       # pulls nhost.toml and .secrets

# Then export the current metadata from your live cloud project
# (requires Hasura CLI with config.yaml pointing at cloud)
# OR: use the Nhost dashboard → Hasura console → Settings → Export Metadata
# and place the exported files in nhost/metadata/
```

The safest route: open your Nhost Dashboard → Hasura Console → **Settings
(gear icon) → Import/Export → Export Metadata**. This downloads the exact
metadata your cloud project currently has. Unzip it into `nhost/metadata/`
and commit.

---

## Commit and verify

```bash
git add nhost/metadata/
git status   # confirm databases.yaml and all table files are staged
git commit -m "fix: restore metadata databases.yaml and table structure"
git push
```

After pushing, watch the Nhost Dashboard → **Deployments** log. The step that
was previously failing (`Applying metadata` or `Metadata inconsistency`) should
now pass. The `config.yaml` fatal error will not appear once Nhost's own metadata
pipeline completes successfully.

---

## Summary

| What was wrong | What to add |
|---|---|
| `nhost/metadata/databases/databases.yaml` missing | Create it — declares the `default` Postgres DB |
| `nhost/metadata/databases/default/tables/tables.yaml` possibly missing | Create it — `[]` if no custom tables, or list of `!include` entries |
| `nhost/metadata/databases/default/functions/functions.yaml` possibly missing | Create it — `[]` if no tracked functions |
| `nhost/metadata/version.yaml` possibly missing | Create it — `version: 3` |

No second database needed. No `config.yaml` needed in the repo. The `config.yaml`
error disappears once `databases.yaml` exists and Nhost can apply metadata through
its own pipeline again.
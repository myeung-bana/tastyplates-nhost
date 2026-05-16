# Rule: `config.yaml` missing — what it means and how to fix it

## The error

```
time="2026-05-16T15:36:37Z" level=fatal msg="validating current directory failed:
cannot find [config.yaml] | search stopped: filesystem boundary hit"
```

## What is actually happening

This error comes from the **Hasura CLI**, not the Nhost CLI. When any Hasura CLI
command runs (`hasura metadata apply`, `hasura migrate apply`, `hasura console`,
etc.) it walks up the directory tree from the current working directory looking for
a `config.yaml` file. If it reaches the filesystem root without finding one, it
stops and logs this fatal error.

The phrase "filesystem boundary hit" means the upward search exhausted every parent
directory — the file simply does not exist anywhere in the tree from where the
command was invoked.

## Why `config.yaml` is missing in a Nhost project

This is the most important thing to understand:

**`config.yaml` is a Hasura CLI artifact. `nhost.toml` is the Nhost CLI artifact.
They are not the same file and they serve different purposes.**

Nhost moved away from `config.yaml` when it introduced `nhost.toml` as its project
configuration format. `nhost init` generates `nhost/nhost.toml` — it does **not**
generate a `config.yaml`. If something in your project or CI pipeline is invoking
the Hasura CLI directly (rather than going through `nhost up` / `nhost deploy`),
it will fail because `config.yaml` was never created.

### Common triggers

| Trigger | Why it causes the error |
|---|---|
| Running `hasura metadata apply` directly | Hasura CLI requires `config.yaml` to know the endpoint and admin secret |
| Running `hasura migrate apply` directly | Same — Hasura CLI, not Nhost CLI |
| A CI step that calls the Hasura CLI | Pipeline is using the wrong tool for a Nhost project |
| Running a Hasura command from inside `nhost/metadata/` | CWD is inside the project but still no `config.yaml` exists anywhere above it |
| An old script copied from a non-Nhost Hasura project | Scripts assume the Hasura CLI workflow, not the Nhost workflow |
| Running `hasura console` instead of using the Nhost dashboard | Hasura console via CLI needs `config.yaml` |

### What `config.yaml` looks like (for reference only)

This is what the Hasura CLI expects — you only need this if you are intentionally
using the Hasura CLI standalone alongside Nhost:

```yaml
version: 3
endpoint: https://<subdomain>.hasura.<region>.nhost.run
admin_secret: <your-admin-secret>
metadata_directory: metadata
migrations_directory: migrations
```

---

## The fix — two paths depending on your situation

### Path 1 — You should not be calling the Hasura CLI at all (most common)

Replace every direct `hasura` CLI call with the equivalent Nhost CLI command.
The Nhost CLI wraps Hasura under the hood and handles `config.yaml` internally.

| Do not use | Use instead |
|---|---|
| `hasura metadata apply` | `nhost up` (applies on start) or `nhost deploy` |
| `hasura migrate apply` | `nhost up` (applies on start) or `nhost deploy` |
| `hasura metadata export` | `nhost metadata export` (linked cloud project) or local dashboard after `nhost up` |
| `hasura console` | Open `https://local.dashboard.local.nhost.run` after `nhost up` |

In CI/CD, use `nhost deploy` (linked project) rather than calling Hasura CLI steps
manually.

---

### Path 2 — You genuinely need the Hasura CLI alongside Nhost

If a specific workflow requires direct Hasura CLI access (e.g. running
`hasura metadata inconsistency drop` to clear stale metadata), create a minimal
`config.yaml` at the **repo root** (same level as the `nhost/` folder):

```yaml
# config.yaml — Hasura CLI configuration for direct CLI access
# Only needed if calling hasura CLI commands manually.
# The Nhost CLI (nhost up / nhost deploy) does not use this file.
version: 3
endpoint: https://<subdomain>.hasura.<region>.nhost.run
admin_secret: <your-admin-secret>
metadata_directory: nhost/metadata
migrations_directory: nhost/migrations
```

Point `metadata_directory` and `migrations_directory` at your existing `nhost/`
subdirectories so Hasura CLI reads from the same source of truth.

> **Do not commit `admin_secret` in plain text.** Use an environment variable
> reference or pass `--admin-secret` as a CLI flag instead:
>
> ```yaml
> version: 3
> endpoint: https://<subdomain>.hasura.<region>.nhost.run
> metadata_directory: nhost/metadata
> migrations_directory: nhost/migrations
> ```
>
> ```bash
> hasura metadata apply --admin-secret "$NHOST_ADMIN_SECRET"
> ```

---

## Required repository structure

The Nhost CLI expects this layout. Every item listed is required for `nhost up` /
`nhost deploy` to apply metadata without errors.

```
<repo-root>/                          # tastyplates-nhost/
├── .secrets                          # Local secrets — NEVER commit
├── config.yaml.example               # Optional; only for direct Hasura CLI (see Path 2)
├── nhost/
│   ├── nhost.toml                    # ← Nhost project config (replaces config.yaml)
│   ├── migrations/
│   │   ├── default/                  # Auto-applied migrations (timestamp_name/)
│   │   ├── held/                     # Manual migrations — NOT auto-applied
│   │   └── README.md                 # Order, preflight SQL, held migration policy
│   └── metadata/
│       ├── version.yaml              # Hasura metadata version (3)
│       ├── README.md                 # Export-first workflow notes
│       └── databases/
│           ├── databases.yaml        # PG source + !include tables index
│           └── default/
│               └── tables/
│                   ├── tables.yaml   # !include every public_*.yaml / auth_users.yaml
│                   └── *.yaml        # One file per tracked table
└── functions/                        # Nhost Functions (NOT functions/src/)
    ├── _lib/                         # Shared helpers — not exposed as routes
    ├── health.ts
    └── restaurant-reviews/
        └── ...
```

See [AI_rules.md](./AI_rules.md) for handler layout (`functions/<route>.ts`, no `functions/src/`).
For schema deprecation and migration phases, see [final-deprecation-migration.md](./final-deprecation-migration.md) (Phase E-3 metadata, E-2 preflight audits).

If `nhost/nhost.toml` does not exist, run:

```bash
# For a new project
nhost init

# For an existing cloud project
nhost login
nhost link
nhost config pull
```

`nhost config pull` downloads the current cloud configuration and writes
`nhost/nhost.toml` and `.secrets` locally, then adds `.secrets` to `.gitignore`.

---

## Metadata folder rules (for `nhost/metadata/`)

These rules apply when writing or editing metadata files directly. Violating them
causes either this `config.yaml` error (wrong CWD) or metadata apply failures.

### Export-first workflow (preferred)

Do **not** hand-author the full metadata tree from scratch. After linking the cloud
project from the repo root:

```bash
nhost login
nhost link
nhost metadata export    # writes version.yaml, databases.yaml, tables.yaml, public_*.yaml
```

If you add a relationship in the Hasura console (e.g. `restaurant_reviews.author` →
`user_profiles`), export again so YAML matches what Hasura expects. For intentional
git-only diffs, merge into the exported file (same structure as export — not a
two-key fragment).

Bootstrapped metadata in this repo was seeded from `tastyplates-backend` plus new
`user_profiles` / `auth.users` tables; re-export after the first successful deploy
and diff against git.

1. **Never run Hasura CLI commands from inside `nhost/metadata/`.** Always run
   from the repo root where `config.yaml` exists (if using Hasura CLI directly)
   or where `nhost/nhost.toml` exists (if using Nhost CLI).

2. **`tables.yaml` is the index.** Every table YAML file under
   `nhost/metadata/databases/default/tables/` must be listed in `tables.yaml`
   with a `!include` directive. A table file that exists on disk but is not
   listed in `tables.yaml` is invisible to Hasura.

   ```yaml
   # nhost/metadata/databases/default/tables/tables.yaml
   - "!include public_restaurant_reviews.yaml"
   - "!include public_user_profiles.yaml"
   - "!include public_restaurant_user_follows.yaml"
   ```

3. **Removing a tracked table from metadata must be done in two places:**
   delete the table's YAML file **and** remove its `!include` line from
   `tables.yaml`. Doing only one causes inconsistent metadata on the next apply.

4. **Do not hand-edit metadata files while `nhost up` is running** unless you
   immediately follow with a metadata reload. Changes on disk are not picked up
   automatically mid-session.

5. **Relationships declared in metadata YAML must match the actual FK constraints
   in the database.** A relationship pointing at a table or column that no longer
   exists causes metadata inconsistency and blocks all GraphQL operations.
   Run `hasura metadata inconsistency drop` (from repo root with a valid
   `config.yaml`) to clear stale entries if this happens.

6. **`version.yaml` and `databases/databases.yaml` must exist.** Hasura metadata v3
   requires both plus `default/tables/tables.yaml`. A missing index or version file
   causes metadata apply to fail.

   ```yaml
   # nhost/metadata/version.yaml
   version: 3
   ```

7. **Migrations in `held/` are not deployed.** Only folders under
   `nhost/migrations/default/` run on `nhost deploy`. Move a migration into `default/`
   only after staging preflight audits pass (see `nhost/migrations/README.md`).

---

## Quick diagnosis checklist

Run these in order to find which case you are in:

```bash
# 1. Confirm nhost.toml exists — if not, run nhost init or nhost config pull
ls nhost/nhost.toml

# 2. Check what command is actually triggering the error
# Look for 'hasura' in your package.json scripts, CI config, or Makefile
grep -r "hasura " .github/ Makefile package.json 2>/dev/null

# 3. Confirm you are running nhost CLI commands from the repo root, not a subdirectory
pwd   # should be the repo root containing the nhost/ folder

# 4. If you need direct Hasura CLI access, confirm config.yaml exists at repo root
ls config.yaml

# 5. Validate the Nhost config is well-formed
nhost config validate
```

---

## Summary

| Question | Answer |
|---|---|
| What file is missing? | `config.yaml` — the Hasura CLI's own config file |
| Why does Nhost not have one by default? | Nhost uses `nhost/nhost.toml` instead |
| What generates `nhost.toml`? | `nhost init` or `nhost config pull` |
| Is `config.yaml` required for normal Nhost deploys? | No — `nhost up` and `nhost deploy` do not need it |
| When do you need `config.yaml`? | Only when calling the Hasura CLI directly and intentionally |
| What is the safest fix? | Replace direct `hasura` CLI calls with `nhost` CLI equivalents |
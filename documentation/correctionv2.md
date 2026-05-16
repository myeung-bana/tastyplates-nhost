# Deployment Fix List — `config.yaml` Error & Root Causes

Repository: `github.com/myeung-bana/tastyplates-nhost`
Error: `level=fatal msg="validating current directory failed: cannot find [config.yaml] | search stopped: filesystem boundary hit"`

---

## Why `config.yaml` being in `.gitignore` is NOT the problem

The `.gitignore` correctly excludes `.secrets`. However, `config.yaml` is **not
listed in `.gitignore`** — only `config.yaml.example` exists in the repo.

More importantly: **you are right that `config.yaml` should not be committed.**
But that is not what is causing this error.

The error is thrown by the **Hasura CLI**, which Nhost's deploy pipeline invokes
internally during metadata apply. The Hasura CLI walks up the directory tree from
wherever it is invoked, looking for `config.yaml`. It reaches the filesystem root
without finding one and fatals.

This only happens when **something is wrong with `nhost/nhost.toml`** — because
when `nhost.toml` is valid and present, Nhost's deploy system handles metadata
apply itself without falling through to raw Hasura CLI invocations that require
`config.yaml`.

The `config.yaml` error is therefore a **symptom** of a broken or missing
`nhost.toml`, not a problem with `config.yaml` itself.

---

## The actual root causes — in order of likelihood

### Root cause 1 — `nhost/nhost.toml` is missing or not committed

**Most likely cause of the error.**

The Nhost deploy pipeline reads `nhost/nhost.toml` from the git repo to
configure the project. If this file is absent from git (not committed, or
accidentally gitignored), Nhost cannot validate the project config and the
deploy fails — with the Hasura CLI's `config.yaml` error appearing because the
pipeline attempted a fallback metadata operation without a valid config.

The README lists `nhost/nhost.toml` in its directory table, but a file being
documented does not mean it is committed. The file was not accessible via any
public URL fetch, which is consistent with it being absent from the repo.

**Fix:**

```bash
# From the repo root — if you have a local copy
git add nhost/nhost.toml
git commit -m "chore: add nhost.toml"
git push

# If nhost.toml doesn't exist locally either, pull it from your cloud project
nhost login
nhost link    # select your project
nhost config pull
# Review the file — ensure no secrets are in it
git add nhost/nhost.toml
git commit -m "chore: pull nhost.toml from cloud"
git push
```

The minimum valid `nhost/nhost.toml` for this project is:

```toml
[functions.node]
version = 22
```

A complete example that also pins Hasura and auth versions:

```toml
[hasura]
version = "v2.36.0-ce"
adminSecret = "{{ secrets.HASURA_GRAPHQL_ADMIN_SECRET }}"
webhookSecret = "{{ secrets.NHOST_WEBHOOK_SECRET }}"

[[hasura.jwtSecrets]]
type = "HS256"
key = "{{ secrets.HASURA_GRAPHQL_JWT_SECRET }}"

[auth]
version = "0.32.1"

[postgres]
version = "14.11-20240515-1"

[storage]
version = "0.6.1"

[functions.node]
version = 22

[observability.grafana]
adminPassword = "{{ secrets.GRAFANA_ADMIN_PASSWORD }}"
```

**Do not put secret values in plain text.** All secrets must be referenced as
`{{ secrets.YOUR_SECRET_NAME }}` and set in Dashboard → Settings → Secrets.

---

### Root cause 2 — `nhost/nhost.toml` exists but references a secret that is not set in the dashboard

**Second most likely cause.**

The README explicitly says:

> Under **Settings → Secrets**, ensure the names referenced in `nhost/nhost.toml`
> exist (for example `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`,
> `GRAFANA_ADMIN_PASSWORD`).

If `nhost.toml` contains `{{ secrets.GRAFANA_ADMIN_PASSWORD }}` but that secret
is not set in the Nhost Dashboard, config validation fails before any deploy step
runs — and the resulting error often surfaces as the Hasura CLI `config.yaml`
fatal because the pipeline aborts mid-flight.

**Fix:**

Go to Nhost Dashboard → your project → **Settings → Secrets** and confirm all
three secrets exist:

| Secret name | What it is |
|---|---|
| `HASURA_GRAPHQL_ADMIN_SECRET` | Hasura admin secret (any strong string) |
| `HASURA_GRAPHQL_JWT_SECRET` | JWT signing key for HS256 |
| `GRAFANA_ADMIN_PASSWORD` | Grafana monitoring password |

If any are missing, add them. Secret names are case-sensitive and must match
exactly what `nhost.toml` references.

After adding secrets, trigger a redeploy (push an empty commit or use the
dashboard Redeploy button).

---

### Root cause 3 — `functions/` has no lockfile committed

Nhost detects the package manager by the lockfile present: `package-lock.json` for npm, `yarn.lock` for yarn, or `pnpm-lock.yaml` for pnpm. If no lockfile is present in `functions/`, the build step cannot install dependencies and may fail in a way that cascades into the Hasura CLI error.

**Fix:**

```bash
cd functions
npm install          # generates package-lock.json
cd ..
git add functions/package-lock.json
git commit -m "chore: commit functions lockfile"
git push
```

Only one lockfile should be present. If `yarn.lock` and `package-lock.json`
both exist, remove one — npm takes priority when both are present.

---

### Root cause 4 — Functions handler files are inside `functions/src/` instead of directly in `functions/`

Nhost Functions expects `.js` or `.ts` files placed directly inside the `./functions` directory of the project. A file at `functions/src/health.ts` is not reachable — Nhost will not find it as a handler. During the deploy build step, if the functions bundler finds no valid entry points, it can fail in a way that causes the Hasura CLI to be invoked separately, which then throws the `config.yaml` error.

**Fix — check your actual file positions:**

```bash
# From repo root — this should show your handlers
ls functions/
# Expected: health.ts, echo.ts, _lib/, categories/, etc.

# If you see this instead, the files are nested incorrectly:
ls functions/
# src/   ← wrong — all handlers are buried one level too deep
```

If files are in `functions/src/`, move them:

```bash
cd functions
mv src/_lib ./_lib
mv src/health.ts ./health.ts
mv src/echo.ts ./echo.ts
# repeat for each subdirectory
rmdir src
cd ..
git add -A
git commit -m "fix: move functions out of src/ to match Nhost routing"
git push
```

Also update `functions/tsconfig.json` — remove `"rootDir": "src"` and change
`"include": ["src/**/*"]` to `"include": ["**/*.ts"]`.

---

### Root cause 5 — `nhost/metadata/` is missing required files

The Nhost deploy pipeline applies Hasura metadata from `nhost/metadata/`. If
this directory is empty, missing entirely, or missing `version.yaml`, the
metadata apply step will invoke the Hasura CLI in a way that expects `config.yaml`
to exist.

The minimum required structure is:

```
nhost/
├── nhost.toml
├── migrations/
│   └── default/           # can be empty initially
└── metadata/
    ├── version.yaml        # REQUIRED
    └── databases/
        └── default/
            └── tables/
                └── tables.yaml   # can be empty array initially
```

**`nhost/metadata/version.yaml`** must contain:

```yaml
version: 3
```

**`nhost/metadata/databases/default/tables/tables.yaml`** must exist (even if
empty — an empty array `[]` is valid for a fresh project with no tracked tables
beyond what Nhost auto-tracks):

```yaml
[]
```

**Fix — confirm both files exist and are committed:**

```bash
git ls-files nhost/metadata/
# Must include at minimum:
# nhost/metadata/version.yaml
# nhost/metadata/databases/default/tables/tables.yaml
```

If they are missing:

```bash
mkdir -p nhost/metadata/databases/default/tables
echo "version: 3" > nhost/metadata/version.yaml
echo "[]" > nhost/metadata/databases/default/tables/tables.yaml
git add nhost/metadata/
git commit -m "fix: add minimum Hasura metadata structure"
git push
```

---

## What to confirm is NOT in `.gitignore`

Your current `.gitignore` is:

```
node_modules/
dist/
.env
.env.local
.secrets
*.js.map
```

This is correct. `nhost/nhost.toml` is not gitignored (good — it must be
committed). `config.yaml` is not gitignored either, which means if you ever
create one locally it could be accidentally committed. Add it as a safety measure:

```
node_modules/
dist/
.env
.env.local
.secrets
*.js.map
config.yaml
```

---

## Ordered fix sequence

Run these in order. Stop and verify after each one before moving to the next.

**Step 1 — confirm `nhost/nhost.toml` is committed**

```bash
git ls-files nhost/nhost.toml
# If this returns nothing, the file is not committed
```

If not present: `nhost config pull` → commit → push.

**Step 2 — confirm all secrets exist in the Nhost Dashboard**

Dashboard → Settings → Secrets → verify `HASURA_GRAPHQL_ADMIN_SECRET`,
`HASURA_GRAPHQL_JWT_SECRET`, and `GRAFANA_ADMIN_PASSWORD` all exist.

**Step 3 — confirm lockfile is committed**

```bash
git ls-files functions/package-lock.json functions/yarn.lock functions/pnpm-lock.yaml
# Must return at least one result
```

If empty: `cd functions && npm install` → commit `package-lock.json` → push.

**Step 4 — confirm metadata minimum files exist**

```bash
git ls-files nhost/metadata/version.yaml
git ls-files nhost/metadata/databases/default/tables/tables.yaml
# Both must return a result
```

**Step 5 — validate config locally before pushing**

```bash
nhost config validate
# Must return: "Configuration is valid!"
# Any error here will also cause the deploy error
```

**Step 6 — push and watch the deployment log**

After pushing, go to Nhost Dashboard → **Deployments** → click the latest
deployment → expand the logs. The error will appear at the specific step
(Config Validation, Metadata Apply, or Functions Build) which narrows down
which root cause above applies.

---

## Summary

| Issue | Evidence | Fix |
|---|---|---|
| `nhost/nhost.toml` not committed | File not accessible in repo, README references it but can't be fetched | `nhost config pull` → commit |
| Missing secret in dashboard | README explicitly warns about `GRAFANA_ADMIN_PASSWORD` | Add all 3 secrets in Dashboard → Secrets |
| No lockfile in `functions/` | Not visible in repo root listing | `npm install` in `functions/` → commit lockfile |
| `nhost/metadata/version.yaml` missing | Not confirmed present | Create with `version: 3` → commit |
| Functions in `functions/src/` | Nhost routes from `functions/` root directly | Move files up one level |

The `config.yaml` error is a **downstream symptom** of one or more of the above.
Fixing the root causes eliminates the need for `config.yaml` entirely — it
should never exist in this repo in committed form.
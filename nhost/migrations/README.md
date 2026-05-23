# Database migrations

Nhost applies migrations under `default/` on `nhost up` and Git deploy.

## Metadata-only deploys

An empty `default/` folder (`.gitkeep` only) is valid: deploy will apply **metadata** from `nhost/metadata/` without running SQL.

## Adding SQL later

When ready, add versioned folders under `default/` (source of truth also lives in monorepo `Repo/migrations/`). Before FK retarget migrations, run preflight audits in `documentation/final-deprecation-migration.md` §E-2.

Held migrations must stay outside `default/` (e.g. `held/`) so Nhost does not apply them automatically.

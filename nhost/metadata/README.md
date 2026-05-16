# Hasura metadata (Nhost)

This directory should stay a **complete** Hasura metadata v3 export. Do not commit a single orphan table file without `version.yaml`, `databases/databases.yaml`, and `tables.yaml`.

## After linking a cloud project

From the repo root (`tastyplates-nhost/`):

```bash
nhost login
nhost link
nhost metadata export   # refresh from dashboard when permissions change
```

Re-merge any intentional diffs (e.g. `public_restaurant_reviews.yaml` → `author` → `user_profiles`) after export.

## Source of initial table permissions

Several `public_*.yaml` files were bootstrapped from `tastyplates-backend/nhost/metadata/tables/` and extended for `user_profiles`, `auth.users`, and additional public tables used by Functions.

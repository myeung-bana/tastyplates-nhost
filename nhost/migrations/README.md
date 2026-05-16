# Database migrations

Migrations under `default/` are applied automatically on `nhost up` / `nhost deploy` in timestamp order.

## Current `default/` chain

1. `20260516120000_user_profiles_gaps` — adds `deleted_at`, geo columns, `pronoun` on `user_profiles`
2. `20260516120100_fk_to_auth_users` — retargets FKs from `restaurant_users(id)` to `auth.users(id)`

## Held migrations (`held/`)

**Not applied by Nhost** (outside `default/`). Move into `default/` only after staging audits pass.

- `held/20260516120200_drop_restaurant_users` — drops `public.restaurant_users`

### Preflight before FK migration + drop

Run on staging (from [final-deprecation-migration.md](../documentation/final-deprecation-migration.md) §E-2). Every query must return **0 rows**:

```sql
SELECT author_id FROM restaurant_reviews
WHERE author_id NOT IN (SELECT id FROM auth.users);

SELECT user_id FROM restaurant_review_likes
WHERE user_id NOT IN (SELECT id FROM auth.users);

SELECT mentioned_user_id FROM restaurant_review_mentions
WHERE mentioned_user_id NOT IN (SELECT id FROM auth.users);

SELECT follower_id FROM restaurant_user_follows
WHERE follower_id NOT IN (SELECT id FROM auth.users);

SELECT user_id FROM restaurant_user_follows
WHERE user_id NOT IN (SELECT id FROM auth.users);

SELECT user_id FROM user_favorites
WHERE user_id NOT IN (SELECT id FROM auth.users);

SELECT user_id FROM user_checkins
WHERE user_id NOT IN (SELECT id FROM auth.users);
```

# User profile location schema

Apply this when Edit Profile saves **"Invalid hometown"** for Google city picks but quick TastyPlates city pills work.

## 1. Run SQL (Nhost Dashboard)

**Database → SQL Editor** → run:

[`add_user_profiles_location.sql`](./add_user_profiles_location.sql)

Idempotent — safe to run more than once.

## 2. Hasura permissions (`user` role)

If you track metadata in git (`Repo/metadata/.../public_user_profiles.yaml`), reload metadata from that file.

Otherwise, in **Hasura Console → Data → user_profiles → Permissions → user → select**, ensure these columns are allowed:

- `current_location_id`
- `current_location_slug`
- `current_latitude`
- `current_longitude`
- `current_location_label`
- `current_google_place_id`
- `hometown_location_id`
- `hometown_location_slug`
- `hometown_latitude`
- `hometown_longitude`
- `hometown_location_label`
- `hometown_google_place_id`
- `location_profile_updated_at`

Writes go through Nhost functions (admin), so no extra insert/update permission is required for mobile.

## 3. Restart Nhost functions

Redeploy or restart so `functions/_lib/userLocationProfile.ts` is live. That module accepts:

```json
{
  "hometown": {
    "label": "Seoul, South Korea",
    "latitude": 37.5665,
    "longitude": 126.9780,
    "google_place_id": "ChIJ..."
  }
}
```

Quick CMS picks may also send `"location_slug": "toronto"` — optional.

## 4. Verify

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'user_profiles'
  AND column_name LIKE '%location%'
ORDER BY column_name;
```

Expect 13 location-related columns including `hometown_location_label` and `current_google_place_id`.

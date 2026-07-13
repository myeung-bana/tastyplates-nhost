-- Profile residence + hometown on user_profiles
-- Supports:
--   • TastyPlates CMS cities (location_id / location_slug)
--   • Global cities via Google Places (label + lat/lng + google_place_id)
--
-- How to apply (no Hasura migrations folder required):
--   1. Nhost Dashboard → Database → SQL Editor → paste & run this file
--   2. Hasura Console → user_profiles → Permissions → user role SELECT:
--        add columns listed in add_user_profiles_location.md
--   3. Redeploy / restart Nhost functions (userLocationProfile.ts)
--
-- Safe to re-run (IF NOT EXISTS).

-- ── CMS-linked + cached coordinates ─────────────────────────────────────────

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS current_location_id integer
    REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_location_slug text,
  ADD COLUMN IF NOT EXISTS current_latitude numeric(9, 6),
  ADD COLUMN IF NOT EXISTS current_longitude numeric(9, 6),

  ADD COLUMN IF NOT EXISTS hometown_location_id integer
    REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hometown_location_slug text,
  ADD COLUMN IF NOT EXISTS hometown_latitude numeric(9, 6),
  ADD COLUMN IF NOT EXISTS hometown_longitude numeric(9, 6),

  ADD COLUMN IF NOT EXISTS location_profile_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_profiles_current_location_slug
  ON public.user_profiles (current_location_slug)
  WHERE current_location_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_hometown_location_slug
  ON public.user_profiles (hometown_location_slug)
  WHERE hometown_location_slug IS NOT NULL;

-- ── Free-form geographic labels (global Google city picks) ──────────────────

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS current_location_label text,
  ADD COLUMN IF NOT EXISTS current_google_place_id text,
  ADD COLUMN IF NOT EXISTS hometown_location_label text,
  ADD COLUMN IF NOT EXISTS hometown_google_place_id text;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'user_profiles'
--   AND column_name LIKE '%location%'
-- ORDER BY column_name;

ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS zip_code,
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS pronoun;

DROP INDEX IF EXISTS idx_user_profiles_active;

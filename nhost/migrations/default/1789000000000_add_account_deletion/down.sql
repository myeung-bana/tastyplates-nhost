DROP INDEX IF EXISTS public.idx_user_profiles_deletion_due;

ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS anonymized_at,
  DROP COLUMN IF EXISTS deletion_scheduled_for,
  DROP COLUMN IF EXISTS deletion_requested_at;

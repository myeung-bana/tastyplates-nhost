-- Phase E-1: user_profiles schema gaps for soft delete and legacy field parity

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_active
  ON public.user_profiles (deleted_at)
  WHERE deleted_at IS NULL;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS address text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS zip_code text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS latitude numeric(9, 6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS longitude numeric(9, 6) DEFAULT NULL;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS pronoun text DEFAULT NULL;

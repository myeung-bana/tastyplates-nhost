ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS first_name,
  DROP COLUMN IF EXISTS last_name;

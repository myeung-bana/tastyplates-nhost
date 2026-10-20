-- First and last name collected in onboarding steps 2–3 (mobile brand v1.0).
--
-- Private: never returned on public profiles. They only feed the display-name options
-- (full, initial + last, first only, last only); the chosen value is auth.users.display_name.
-- Functions read and write these through the admin client, so no extra role permissions.
-- Idempotent.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name  text;

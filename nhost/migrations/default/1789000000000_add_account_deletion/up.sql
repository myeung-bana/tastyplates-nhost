-- Account deletion with a 30-day grace period (Google Play account deletion policy).
--
-- Request: deleted_at + deletion_requested_at = now(), deletion_scheduled_for = now() + 30 days.
-- Restore: clears all three while anonymized_at is null.
-- Purge (admin/purge-deleted-accounts, daily cron): anonymises the account and sets anonymized_at.
--
-- Functions read and write these columns through run_sql, so no Hasura tracking change is required.
-- Idempotent.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS deletion_requested_at  timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS anonymized_at          timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_profiles_deletion_due
  ON public.user_profiles (deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL AND anonymized_at IS NULL;

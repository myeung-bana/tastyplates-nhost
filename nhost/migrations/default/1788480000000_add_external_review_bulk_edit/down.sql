-- Destructive: drops all bulk-edit audit history and the review edit-version columns.
-- Untrack apply_external_review_edit_batch and both tables in Hasura before running.

DROP FUNCTION IF EXISTS public.apply_external_review_edit_batch(uuid, integer, text);

DROP TABLE IF EXISTS public.external_review_edit_batch_items;

DROP TABLE IF EXISTS public.external_review_edit_batches;

DROP INDEX IF EXISTS public.idx_ext_reviews_edit_version;

ALTER TABLE public.restaurant_external_reviews
  DROP COLUMN IF EXISTS edit_version,
  DROP COLUMN IF EXISTS updated_at;

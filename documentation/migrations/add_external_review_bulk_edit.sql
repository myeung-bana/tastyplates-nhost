-- Bulk external review curation: versioning, audit batches, atomic apply.
--
-- How to apply:
--   1. Run in Nhost SQL editor after add_restaurant_external_reviews.sql
--   2. Hasura Console → track tables:
--        external_review_edit_batches
--        external_review_edit_batch_items
--   3. Track function: apply_external_review_edit_batch (admin/service role only)
--
-- Safe to re-run where noted (IF NOT EXISTS / OR REPLACE).

BEGIN;

ALTER TABLE public.restaurant_external_reviews
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS edit_version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_ext_reviews_edit_version
  ON public.restaurant_external_reviews (id, edit_version);

CREATE TABLE IF NOT EXISTS public.external_review_edit_batches (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_uuid     uuid          NOT NULL REFERENCES public.restaurants (uuid) ON DELETE CASCADE,
  admin_user_id       text          NOT NULL,
  export_id           text,
  schema_version      text          NOT NULL DEFAULT '1.0',
  status              text          NOT NULL DEFAULT 'preview'
    CHECK (status IN ('preview', 'applied', 'failed', 'expired')),
  payload_hash        text          NOT NULL,
  submitted_count     integer       NOT NULL DEFAULT 0,
  changed_count       integer       NOT NULL DEFAULT 0,
  unchanged_count     integer       NOT NULL DEFAULT 0,
  invalid_count       integer       NOT NULL DEFAULT 0,
  missing_count       integer       NOT NULL DEFAULT 0,
  conflict_count      integer       NOT NULL DEFAULT 0,
  applied_count       integer       NOT NULL DEFAULT 0,
  failure_message     text,
  rebuild_status      text,
  preview_expires_at  timestamptz   NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  applied_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ext_review_edit_batches_restaurant
  ON public.external_review_edit_batches (restaurant_uuid, created_at DESC);

CREATE TABLE IF NOT EXISTS public.external_review_edit_batch_items (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid          NOT NULL REFERENCES public.external_review_edit_batches (id) ON DELETE CASCADE,
  review_id           uuid          NOT NULL REFERENCES public.restaurant_external_reviews (id) ON DELETE CASCADE,
  row_status          text          NOT NULL
    CHECK (row_status IN ('changed', 'unchanged', 'invalid', 'missing', 'conflict')),
  expected_version    integer,
  normalized_changes  jsonb,
  before_state        jsonb,
  after_state         jsonb,
  diff_fields         text[]        NOT NULL DEFAULT '{}',
  error_message       text,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ext_review_edit_batch_items_batch
  ON public.external_review_edit_batch_items (batch_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_review_edit_batch_items_batch_review
  ON public.external_review_edit_batch_items (batch_id, review_id);

CREATE OR REPLACE FUNCTION public.apply_external_review_edit_batch(
  p_batch_id uuid,
  p_confirm_changed_count integer,
  p_admin_user_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch public.external_review_edit_batches%ROWTYPE;
  v_item record;
  v_review public.restaurant_external_reviews%ROWTYPE;
  v_applied integer := 0;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_batch
  FROM public.external_review_edit_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;

  IF v_batch.status <> 'preview' THEN
    RAISE EXCEPTION 'Batch is not in preview state (current: %)', v_batch.status;
  END IF;

  IF v_batch.preview_expires_at < v_now THEN
    UPDATE public.external_review_edit_batches
    SET status = 'expired', failure_message = 'Preview expired'
    WHERE id = p_batch_id;
    RAISE EXCEPTION 'Preview expired';
  END IF;

  IF v_batch.changed_count <> p_confirm_changed_count THEN
    RAISE EXCEPTION 'Confirmation count mismatch: expected %, got %', v_batch.changed_count, p_confirm_changed_count;
  END IF;

  IF v_batch.invalid_count > 0 OR v_batch.missing_count > 0 OR v_batch.conflict_count > 0 THEN
    RAISE EXCEPTION 'Batch contains invalid, missing, or conflict rows';
  END IF;

  IF v_batch.changed_count = 0 THEN
    RAISE EXCEPTION 'No changed rows to apply';
  END IF;

  FOR v_item IN
    SELECT *
    FROM public.external_review_edit_batch_items
    WHERE batch_id = p_batch_id AND row_status = 'changed'
    ORDER BY review_id
  LOOP
    SELECT * INTO v_review
    FROM public.restaurant_external_reviews
    WHERE id = v_item.review_id
      AND restaurant_uuid = v_batch.restaurant_uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Review % not found for restaurant', v_item.review_id;
    END IF;

    IF v_review.edit_version <> v_item.expected_version THEN
      RAISE EXCEPTION 'Version conflict on review % (expected %, current %)',
        v_item.review_id, v_item.expected_version, v_review.edit_version;
    END IF;

    UPDATE public.restaurant_external_reviews
    SET
      author_palates = CASE
        WHEN v_item.normalized_changes ? 'author_palates'
          THEN COALESCE(
            ARRAY(SELECT jsonb_array_elements_text(v_item.normalized_changes->'author_palates')),
            '{}'::text[]
          )
        ELSE author_palates
      END,
      palates = CASE
        WHEN v_item.normalized_changes ? 'palates'
          THEN COALESCE(
            ARRAY(SELECT jsonb_array_elements_text(v_item.normalized_changes->'palates')),
            '{}'::text[]
          )
        ELSE palates
      END,
      language = CASE
        WHEN v_item.normalized_changes ? 'language'
          THEN NULLIF(v_item.normalized_changes->>'language', '')
        ELSE language
      END,
      sentiment = CASE
        WHEN v_item.normalized_changes ? 'sentiment'
          THEN NULLIF(v_item.normalized_changes->>'sentiment', '')
        ELSE sentiment
      END,
      is_flagged = CASE
        WHEN v_item.normalized_changes ? 'is_flagged'
          THEN (v_item.normalized_changes->>'is_flagged')::boolean
        ELSE is_flagged
      END,
      flagged_reason = CASE
        WHEN v_item.normalized_changes ? 'flagged_reason'
          THEN NULLIF(v_item.normalized_changes->>'flagged_reason', '')
        ELSE flagged_reason
      END,
      edit_version = edit_version + 1,
      updated_at = v_now
    WHERE id = v_item.review_id;

    v_applied := v_applied + 1;
  END LOOP;

  UPDATE public.external_review_edit_batches
  SET
    status = 'applied',
    applied_count = v_applied,
    applied_at = v_now,
    admin_user_id = COALESCE(NULLIF(p_admin_user_id, ''), admin_user_id)
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'batch_id', p_batch_id,
    'restaurant_uuid', v_batch.restaurant_uuid,
    'applied_count', v_applied,
    'status', 'applied'
  );
EXCEPTION
  WHEN OTHERS THEN
    UPDATE public.external_review_edit_batches
    SET status = 'failed', failure_message = SQLERRM
    WHERE id = p_batch_id;
    RAISE;
END;
$$;

COMMIT;

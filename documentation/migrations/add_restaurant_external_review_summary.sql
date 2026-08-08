-- Precomputed external review signals per restaurant (no raw text).
--
-- How to apply:
--   1. Run after add_restaurant_external_reviews.sql
--   2. Hasura Console → track `restaurant_external_review_summary`
--   3. Permissions: public/user select on aggregate columns only (optional)
--
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.restaurant_external_review_summary (
  restaurant_uuid     uuid          PRIMARY KEY
    REFERENCES public.restaurants (uuid) ON DELETE CASCADE,

  total_count         integer       NOT NULL DEFAULT 0,
  average_rating      numeric(3,2),

  platform_breakdown  jsonb         NOT NULL DEFAULT '{}'::jsonb,
  language_breakdown  jsonb         NOT NULL DEFAULT '{}'::jsonb,
  palate_breakdown    jsonb         NOT NULL DEFAULT '{}'::jsonb,
  sentiment_breakdown jsonb         NOT NULL DEFAULT '{}'::jsonb,

  last_updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ext_review_summary_updated
  ON public.restaurant_external_review_summary (last_updated_at DESC);

COMMENT ON TABLE public.restaurant_external_review_summary IS
  'Precomputed external review signals per restaurant (no raw text).';

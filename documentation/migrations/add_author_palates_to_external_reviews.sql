-- Inferred external reviewer cuisine/ethnic palate slugs (restaurant_palates.slug).
-- Same vocabulary as user_profiles.palates (e.g. korean, chinese).
-- Distinct from palates (taste tags: spicy, umami, …).
--
-- How to apply:
--   1. Nhost Dashboard → Database → SQL Editor → paste & run
--   2. Hasura Console → reload metadata
--
-- Safe to re-run.

ALTER TABLE public.restaurant_external_reviews
  ADD COLUMN IF NOT EXISTS author_palates text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.restaurant_external_reviews.author_palates IS
  'Inferred external reviewer cuisine/regional palate slugs (restaurant_palates.slug). '
  'Best match first; empty when unknown. Distinct from palates (taste tags from review body).';

CREATE INDEX IF NOT EXISTS idx_ext_reviews_author_palates
  ON public.restaurant_external_reviews USING GIN (author_palates);

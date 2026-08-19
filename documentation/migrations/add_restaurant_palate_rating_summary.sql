-- Precomputed reviewer-palate rating aggregates per restaurant.
--
-- How to apply:
--   1. Run after add_restaurant_external_reviews.sql (author_palates column)
--   2. Hasura Console → track `restaurant_palate_rating_summary`
--   3. Track views: palate_leaf_to_parent, restaurant_palate_rating_summary_combined,
--      restaurant_palate_rating_effective
--   4. Permissions: public/user select on aggregate columns only
--
-- Safe to re-run (IF NOT EXISTS / OR REPLACE).

BEGIN;

CREATE TABLE IF NOT EXISTS public.restaurant_palate_rating_summary (
  restaurant_id     integer       NOT NULL
    REFERENCES public.restaurants (id) ON DELETE CASCADE,

  palate_id         integer       NOT NULL
    REFERENCES public.restaurant_palates (id) ON DELETE CASCADE,

  review_source     text          NOT NULL
    CHECK (review_source IN ('first_party', 'external')),

  review_count      integer       NOT NULL DEFAULT 0,
  rating_sum        numeric(12,4) NOT NULL DEFAULT 0,
  rating_avg        numeric(4,2),
  rating_weighted   numeric(6,4),

  reviewer_count    integer       NOT NULL DEFAULT 0,

  review_version    bigint        NOT NULL DEFAULT 0,
  updated_at        timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (restaurant_id, palate_id, review_source),

  CONSTRAINT rprs_review_count_nonnegative CHECK (review_count >= 0),
  CONSTRAINT rprs_rating_sum_nonnegative CHECK (rating_sum >= 0),
  CONSTRAINT rprs_reviewer_count_nonnegative CHECK (reviewer_count >= 0)
);

COMMENT ON TABLE public.restaurant_palate_rating_summary IS
  'Precomputed reviewer-palate rating aggregates. Combined source is derived via view.';

CREATE INDEX IF NOT EXISTS idx_rprs_palate_rank
  ON public.restaurant_palate_rating_summary (palate_id, review_source, rating_weighted DESC NULLS LAST)
  WHERE review_count > 0;

CREATE INDEX IF NOT EXISTS idx_rprs_restaurant
  ON public.restaurant_palate_rating_summary (restaurant_id, review_source);

CREATE INDEX IF NOT EXISTS idx_rprs_updated
  ON public.restaurant_palate_rating_summary (updated_at DESC);

CREATE OR REPLACE VIEW public.palate_leaf_to_parent AS
SELECT
  leaf.id          AS leaf_palate_id,
  leaf.slug        AS leaf_slug,
  leaf.name        AS leaf_name,
  parent.id        AS parent_palate_id,
  parent.slug      AS parent_slug,
  parent.name      AS parent_name
FROM public.restaurant_palates leaf
JOIN public.restaurant_palates parent ON leaf.parent_id = parent.id;

CREATE OR REPLACE VIEW public.restaurant_palate_rating_summary_combined AS
SELECT
  restaurant_id,
  palate_id,
  SUM(review_count) AS review_count,
  SUM(rating_sum)   AS rating_sum,
  ROUND(SUM(rating_sum) / NULLIF(SUM(review_count), 0), 2) AS rating_avg,
  ROUND(
    (SUM(rating_sum) + 4.0 * 5) / (NULLIF(SUM(review_count), 0) + 5),
    4
  ) AS rating_weighted,
  SUM(reviewer_count) AS reviewer_count
FROM public.restaurant_palate_rating_summary
GROUP BY restaurant_id, palate_id;

CREATE OR REPLACE VIEW public.restaurant_palate_rating_effective AS
SELECT
  r.id AS restaurant_id,
  leaf.id   AS requested_palate_id,
  leaf.slug AS requested_palate_slug,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN leaf.id
    ELSE parent.id
  END AS resolved_palate_id,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN leaf.slug
    ELSE parent.slug
  END AS resolved_palate_slug,
  (COALESCE(ls.review_count, 0) < 3) AS is_fallback,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN ls.rating_weighted
    ELSE ps.rating_weighted
  END AS rating_weighted,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN ls.rating_avg
    ELSE ps.rating_avg
  END AS rating_avg,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN ls.review_count
    ELSE ps.review_count
  END AS review_count,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN ls.reviewer_count
    ELSE ps.reviewer_count
  END AS reviewer_count
FROM public.restaurants r
CROSS JOIN public.restaurant_palates leaf
JOIN public.restaurant_palates parent ON parent.id = leaf.parent_id
LEFT JOIN public.restaurant_palate_rating_summary_combined ls
  ON ls.restaurant_id = r.id AND ls.palate_id = leaf.id
LEFT JOIN public.restaurant_palate_rating_summary_combined ps
  ON ps.restaurant_id = r.id AND ps.palate_id = parent.id
WHERE leaf.parent_id IS NOT NULL
  AND (
    COALESCE(ls.review_count, 0) > 0
    OR COALESCE(ps.review_count, 0) > 0
  );

COMMIT;

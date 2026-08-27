-- Correct an earlier palate-rating migration that referenced the flavor/taste
-- taxonomy (`restaurant_palates`). Reviewer ethnic identity is sourced from
-- `restaurant_cuisines`, the taxonomy managed by /dashboard/admin/manage-cuisine.
--
-- Summary data is derived, so it is intentionally discarded and rebuilt.

BEGIN;

DROP VIEW IF EXISTS public.restaurant_palate_rating_effective;
DROP VIEW IF EXISTS public.restaurant_palate_rating_summary_combined;
DROP VIEW IF EXISTS public.palate_leaf_to_parent;
DROP VIEW IF EXISTS public.cuisine_leaf_to_parent;
DROP TABLE IF EXISTS public.restaurant_palate_rating_summary;

CREATE TABLE public.restaurant_palate_rating_summary (
  restaurant_id     integer       NOT NULL
    REFERENCES public.restaurants (id) ON DELETE CASCADE,

  cuisine_id        integer       NOT NULL
    REFERENCES public.restaurant_cuisines (id) ON DELETE CASCADE,

  review_source     text          NOT NULL
    CHECK (review_source IN ('first_party', 'external')),

  review_count      integer       NOT NULL DEFAULT 0,
  rating_sum        numeric(12,4) NOT NULL DEFAULT 0,
  rating_avg        numeric(4,2),
  rating_weighted   numeric(6,4),
  reviewer_count    integer       NOT NULL DEFAULT 0,
  review_version    bigint        NOT NULL DEFAULT 0,
  updated_at        timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (restaurant_id, cuisine_id, review_source),
  CONSTRAINT rprs_review_count_nonnegative CHECK (review_count >= 0),
  CONSTRAINT rprs_rating_sum_nonnegative CHECK (rating_sum >= 0),
  CONSTRAINT rprs_reviewer_count_nonnegative CHECK (reviewer_count >= 0)
);

COMMENT ON TABLE public.restaurant_palate_rating_summary IS
  'Precomputed ratings grouped by reviewer cuisine identity. Combined source is derived via view.';

CREATE INDEX idx_rprs_cuisine_rank
  ON public.restaurant_palate_rating_summary (
    cuisine_id,
    review_source,
    rating_weighted DESC NULLS LAST
  )
  WHERE review_count > 0;

CREATE INDEX idx_rprs_restaurant
  ON public.restaurant_palate_rating_summary (restaurant_id, review_source);

CREATE INDEX idx_rprs_updated
  ON public.restaurant_palate_rating_summary (updated_at DESC);

CREATE VIEW public.cuisine_leaf_to_parent AS
SELECT
  leaf.id          AS leaf_cuisine_id,
  leaf.slug        AS leaf_slug,
  leaf.name        AS leaf_name,
  parent.id        AS parent_cuisine_id,
  parent.slug      AS parent_slug,
  parent.name      AS parent_name
FROM public.restaurant_cuisines leaf
JOIN public.restaurant_cuisines parent ON leaf.parent_id = parent.id;

CREATE VIEW public.restaurant_palate_rating_summary_combined AS
SELECT
  restaurant_id,
  cuisine_id,
  SUM(review_count) AS review_count,
  SUM(rating_sum)   AS rating_sum,
  ROUND(SUM(rating_sum) / NULLIF(SUM(review_count), 0), 2) AS rating_avg,
  ROUND(
    (SUM(rating_sum) + 4.0 * 5) / (NULLIF(SUM(review_count), 0) + 5),
    4
  ) AS rating_weighted,
  SUM(reviewer_count) AS reviewer_count
FROM public.restaurant_palate_rating_summary
GROUP BY restaurant_id, cuisine_id;

CREATE VIEW public.restaurant_palate_rating_effective AS
SELECT
  r.id AS restaurant_id,
  leaf.id   AS requested_cuisine_id,
  leaf.slug AS requested_palate_slug,
  CASE
    WHEN COALESCE(ls.review_count, 0) >= 3 THEN leaf.id
    ELSE parent.id
  END AS resolved_cuisine_id,
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
CROSS JOIN public.restaurant_cuisines leaf
JOIN public.restaurant_cuisines parent ON parent.id = leaf.parent_id
LEFT JOIN public.restaurant_palate_rating_summary_combined ls
  ON ls.restaurant_id = r.id AND ls.cuisine_id = leaf.id
LEFT JOIN public.restaurant_palate_rating_summary_combined ps
  ON ps.restaurant_id = r.id AND ps.cuisine_id = parent.id
WHERE leaf.parent_id IS NOT NULL
  AND (
    COALESCE(ls.review_count, 0) > 0
    OR COALESCE(ps.review_count, 0) > 0
  );

COMMIT;

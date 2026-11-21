-- Restore the v2 (equal-weight) combined view without total_weight.
-- A column can't be removed with CREATE OR REPLACE, so drop and recreate both dependent views.

BEGIN;

DROP VIEW IF EXISTS public.restaurant_palate_rating_effective;
DROP VIEW IF EXISTS public.restaurant_palate_rating_summary_combined;

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

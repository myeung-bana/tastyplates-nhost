-- Rating Model v3 — weight sources in the combined palate view.
--
-- Per-source rows in restaurant_palate_rating_summary stay unweighted (raw rating_sum).
-- This view is the only place weights apply: first_party × 2, external × 1.
-- Spec: documentation/ratings/rating-model-v3.md §7.5 (workspace root).
--
-- Columns keep their names, order and types so restaurant_palate_rating_effective,
-- get-group-scores and the admin panel keep working. Changed meanings:
--   rating_sum       weighted sum   Σ w × rating_sum
--   rating_avg       weighted_sum / total_weight
--   rating_weighted  (weighted_sum + 4.0 × 5) / (total_weight + 5)   smoothing in weight units
--   review_count     number of reviews (unchanged)
--   reviewer_count   upper bound: a reviewer present in both sources counts twice (unchanged)
-- New, appended last: total_weight  Σ w × review_count
--
-- Idempotent.

CREATE OR REPLACE VIEW public.restaurant_palate_rating_summary_combined AS
WITH weighted AS (
  SELECT
    restaurant_id,
    cuisine_id,
    review_count,
    reviewer_count,
    (CASE review_source WHEN 'first_party' THEN 2 ELSE 1 END) AS w,
    rating_sum
  FROM public.restaurant_palate_rating_summary
)
SELECT
  restaurant_id,
  cuisine_id,
  SUM(review_count) AS review_count,
  SUM(w * rating_sum) AS rating_sum,
  ROUND(SUM(w * rating_sum) / NULLIF(SUM(w * review_count), 0), 2) AS rating_avg,
  ROUND(
    (SUM(w * rating_sum) + 4.0 * 5) / (NULLIF(SUM(w * review_count), 0) + 5),
    4
  ) AS rating_weighted,
  SUM(reviewer_count) AS reviewer_count,
  SUM(w * review_count) AS total_weight
FROM weighted
GROUP BY restaurant_id, cuisine_id;

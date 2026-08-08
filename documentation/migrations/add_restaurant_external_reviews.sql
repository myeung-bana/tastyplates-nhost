-- Scraped third-party review rows (internal enrichment — not restaurant_reviews).
--
-- How to apply:
--   1. Nhost Dashboard → Database → SQL Editor → paste & run
--   2. Hasura Console → track `restaurant_external_reviews`
--   3. Permissions: public/user none; admin/service via Functions only
--
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.restaurant_external_reviews (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_uuid     uuid          NOT NULL REFERENCES public.restaurants (uuid) ON DELETE CASCADE,

  source_platform     text          NOT NULL
    CHECK (source_platform IN ('google_maps', 'yelp', 'tripadvisor')),
  source_review_id    text          NOT NULL,
  source_url          text,
  source_author_name  text,
  source_author_id    text,
  reviewed_at         timestamptz,

  rating              numeric(2,1)  NOT NULL CHECK (rating >= 1 AND rating <= 5),
  body                text,

  language            text,
  palates             text[]        NOT NULL DEFAULT '{}',
  sentiment           text          CHECK (sentiment IN ('positive', 'neutral', 'negative')),

  is_flagged          boolean       NOT NULL DEFAULT false,
  flagged_reason      text,

  ingested_at         timestamptz   NOT NULL DEFAULT now(),
  ingest_batch_id     text,

  CONSTRAINT ext_reviews_platform_review_id_uniq
    UNIQUE (source_platform, source_review_id)
);

CREATE INDEX IF NOT EXISTS idx_ext_reviews_restaurant_uuid
  ON public.restaurant_external_reviews (restaurant_uuid);

CREATE INDEX IF NOT EXISTS idx_ext_reviews_platform
  ON public.restaurant_external_reviews (source_platform);

CREATE INDEX IF NOT EXISTS idx_ext_reviews_language
  ON public.restaurant_external_reviews (language)
  WHERE language IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ext_reviews_palates
  ON public.restaurant_external_reviews USING GIN (palates);

CREATE INDEX IF NOT EXISTS idx_ext_reviews_ingested
  ON public.restaurant_external_reviews (ingested_at DESC);

CREATE INDEX IF NOT EXISTS idx_ext_reviews_flagged
  ON public.restaurant_external_reviews (is_flagged)
  WHERE is_flagged = true;

COMMENT ON TABLE public.restaurant_external_reviews IS
  'Scraped third-party review text (internal). Never mixed with restaurant_reviews.';

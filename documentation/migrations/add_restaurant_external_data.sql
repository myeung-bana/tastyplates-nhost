-- Restaurant external enrichment (Apify / third-party sources)
-- Separate from restaurant_reviews — informational context only.
--
-- How to apply:
--   1. Nhost Dashboard → Database → SQL Editor → paste & run this file
--   2. Hasura Console → track `restaurant_external_data`
--   3. Permissions: admin/service role full access; user/public read none (v1 admin-only)
--   4. Redeploy Nhost functions (admin/trigger-apify-scrape, admin/apify-webhook)
--
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.restaurant_external_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_uuid uuid NOT NULL REFERENCES public.restaurants (uuid) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('google_maps', 'yelp', 'tripadvisor')),

  sync_status text NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('pending', 'running', 'succeeded', 'failed')),

  apify_run_id text,
  apify_dataset_id text,

  external_rating numeric(3, 1),
  external_review_count integer,
  price_level text,
  cuisine_tags jsonb,
  popular_dishes jsonb,
  opening_hours jsonb,
  photo_urls jsonb,

  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,

  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (restaurant_uuid, source)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_external_data_restaurant_uuid
  ON public.restaurant_external_data (restaurant_uuid);

CREATE INDEX IF NOT EXISTS idx_restaurant_external_data_apify_run_id
  ON public.restaurant_external_data (apify_run_id)
  WHERE apify_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_restaurant_external_data_sync_status
  ON public.restaurant_external_data (sync_status);

DROP TRIGGER IF EXISTS trg_restaurant_external_data_updated_at ON public.restaurant_external_data;
CREATE TRIGGER trg_restaurant_external_data_updated_at
  BEFORE UPDATE ON public.restaurant_external_data
  FOR EACH ROW
  EXECUTE FUNCTION public.tasty_studio_set_updated_at();

COMMENT ON TABLE public.restaurant_external_data IS
  'Third-party restaurant enrichment from Apify (admin-triggered). Not linked to restaurant_reviews.';

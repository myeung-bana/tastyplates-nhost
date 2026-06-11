-- Hybrid search: fast Google place_id lookup on restaurants.
-- Run once in Nhost Dashboard → SQL Editor (or your migration pipeline).

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS google_place_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_google_place_id
  ON public.restaurants (google_place_id)
  WHERE google_place_id IS NOT NULL;

-- Backfill from legacy JSON address blob when present.
UPDATE public.restaurants
SET google_place_id = trim(both from address->>'place_id')
WHERE google_place_id IS NULL
  AND address->>'place_id' IS NOT NULL
  AND trim(both from address->>'place_id') <> '';

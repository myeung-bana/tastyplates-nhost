-- TastyStudio "My Lists" (tasty-studio-v1.md §6–7)
-- Aligns with:
--   - FK user_id → auth.users(id) (same pattern as Repo/migrations/default/20260516120100_fk_to_auth_users)
--   - FK tastyplates_restaurant_uuid → public.restaurants(uuid)
--   - restaurants.status uses 'publish' | 'draft' (see Nhost functions / create-restaurant)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Optional matching column on listings (§7.2 — exact Google Place match)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS google_place_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS restaurants_google_place_id_key
  ON public.restaurants (google_place_id)
  WHERE google_place_id IS NOT NULL;

COMMENT ON COLUMN public.restaurants.google_place_id IS
  'Google Places place_id for O(1) listing match / My Lists backfill (tasty-studio-v1.md §7).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Shared trigger helper (scoped name — avoids clobbering generic updated_at helpers)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tasty_studio_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. user_place_collections — per-user Google place rows (check-in vs like)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_place_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  list_type text NOT NULL,
  CONSTRAINT user_place_collections_list_type_check
    CHECK (list_type IN ('checkin', 'like')),

  google_place_id text NOT NULL,

  name text NOT NULL,
  address text,
  latitude  numeric(10, 7),
  longitude numeric(10, 7),
  image_url text,
  google_types text[],

  tastyplates_restaurant_uuid uuid REFERENCES public.restaurants (uuid) ON DELETE SET NULL,
  tastyplates_restaurant_slug text,

  location_key text,
  location_label text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_place_collections_user_google_list_unique
    UNIQUE (user_id, google_place_id, list_type)
);

CREATE INDEX IF NOT EXISTS idx_upc_user_list
  ON public.user_place_collections (user_id, list_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_upc_google_place
  ON public.user_place_collections (google_place_id);

CREATE INDEX IF NOT EXISTS idx_upc_tp_uuid
  ON public.user_place_collections (tastyplates_restaurant_uuid)
  WHERE tastyplates_restaurant_uuid IS NOT NULL;

DROP TRIGGER IF EXISTS trg_user_place_collections_updated_at ON public.user_place_collections;
CREATE TRIGGER trg_user_place_collections_updated_at
  BEFORE UPDATE ON public.user_place_collections
  FOR EACH ROW
  EXECUTE FUNCTION public.tasty_studio_set_updated_at();

COMMENT ON TABLE public.user_place_collections IS
  'My Lists: user-saved Google places with optional TastyPlates link (tasty-studio-v1.md §6).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. google_place_cache — shared metadata cache / matching job target
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.google_place_cache (
  google_place_id text PRIMARY KEY,

  name text NOT NULL,
  formatted_address text,
  latitude  numeric(10, 7),
  longitude numeric(10, 7),
  primary_photo_url text,
  google_rating numeric(3, 1),
  user_ratings_total integer,
  google_types text[],
  phone text,
  website text,

  tastyplates_restaurant_uuid uuid REFERENCES public.restaurants (uuid) ON DELETE SET NULL,
  tastyplates_restaurant_slug text,

  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gpc_expires
  ON public.google_place_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_gpc_tp_uuid
  ON public.google_place_cache (tastyplates_restaurant_uuid)
  WHERE tastyplates_restaurant_uuid IS NOT NULL;

DROP TRIGGER IF EXISTS trg_google_place_cache_updated_at ON public.google_place_cache;
CREATE TRIGGER trg_google_place_cache_updated_at
  BEFORE UPDATE ON public.google_place_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.tasty_studio_set_updated_at();

COMMENT ON TABLE public.google_place_cache IS
  'Cached Google Place details + optional TP listing link (tasty-studio-v1.md §6.2).';

-- Roll back tasty_studio_my_lists / up.sql (reverse order)

DROP TRIGGER IF EXISTS trg_google_place_cache_updated_at ON public.google_place_cache;
DROP TABLE IF EXISTS public.google_place_cache;

DROP TRIGGER IF EXISTS trg_user_place_collections_updated_at ON public.user_place_collections;
DROP TABLE IF EXISTS public.user_place_collections;

DROP FUNCTION IF EXISTS public.tasty_studio_set_updated_at();

DROP INDEX IF EXISTS public.restaurants_google_place_id_key;
ALTER TABLE public.restaurants DROP COLUMN IF EXISTS google_place_id;

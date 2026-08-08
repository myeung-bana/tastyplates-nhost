-- Rename external review dedup constraint to a short explicit name.
--
-- Postgres truncates auto-generated UNIQUE names (>63 chars), which breaks Hasura
-- on_conflict.constraint when code references the logical full name.
--
-- How to apply:
--   1. Nhost Dashboard → Database → SQL Editor → paste & run
--   2. Hasura Console → reload metadata (Settings → Reload metadata)
--
-- Safe to re-run.

DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'restaurant_external_reviews'
      AND c.contype = 'u'
      AND c.conname <> 'ext_reviews_platform_review_id_uniq'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.restaurant_external_reviews DROP CONSTRAINT %I',
      con.conname
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ext_reviews_platform_review_id_uniq'
  ) THEN
    ALTER TABLE public.restaurant_external_reviews
      ADD CONSTRAINT ext_reviews_platform_review_id_uniq
      UNIQUE (source_platform, source_review_id);
  END IF;
END $$;

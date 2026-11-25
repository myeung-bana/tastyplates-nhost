-- Personalised readings ("Read it for me" on restaurant detail).
--
-- One row per user, restaurant and local day: a reading is cached for that day and reused.
-- `facts` holds every number (scores, counts, groups, fit band, confidence) computed by the
-- functions from the Rating Model v3 pool; `content` holds only the text the language model wrote.
-- `status` follows the job: gathering → grouping → writing → ready | failed.
--
-- Access: admin only (functions use the admin secret). Track the table in Hasura without
-- public/user permissions. Idempotent.

CREATE TABLE IF NOT EXISTS public.restaurant_readings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  restaurant_uuid  uuid NOT NULL,
  reading_date     date NOT NULL,
  status           text NOT NULL DEFAULT 'gathering'
                   CHECK (status IN ('gathering', 'grouping', 'writing', 'ready', 'failed')),
  facts            jsonb,
  content          jsonb,
  model            text,
  error            text,
  feedback         smallint CHECK (feedback IN (-1, 1)),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, restaurant_uuid, reading_date)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_readings_user_day
  ON public.restaurant_readings (user_id, reading_date);

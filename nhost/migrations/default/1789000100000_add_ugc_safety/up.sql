-- User-generated content safety: reports and blocks (Google Play UGC policy).
--
-- Functions access both tables through run_sql (functions/_lib/contentReports.ts, userBlocks.ts),
-- so no Hasura tracking is required. Idempotent.

CREATE TABLE IF NOT EXISTS public.content_reports (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   uuid,
  target_type   text        NOT NULL CHECK (target_type IN ('review', 'comment', 'user', 'list')),
  target_id     text        NOT NULL,
  target_owner_id uuid,
  reason        text        NOT NULL CHECK (reason IN (
                  'spam', 'harassment', 'hate', 'sexual', 'violence',
                  'misinformation', 'off_topic', 'impersonation', 'other')),
  details       text        CHECK (char_length(details) <= 1000),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolution    text,
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_reports_open
  ON public.content_reports (created_at)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_content_reports_target
  ON public.content_reports (target_type, target_id);

-- One open report per reporter per target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_reports_open_per_reporter
  ON public.content_reports (reporter_id, target_type, target_id)
  WHERE status = 'open' AND reporter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.user_blocks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  uuid        NOT NULL,
  blocked_id  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_unique UNIQUE (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON public.user_blocks (blocked_id);

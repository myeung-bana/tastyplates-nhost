-- Reviewer groups, Stage 1 (insight lenses).
-- Spec: documentation/ratings/palate-groups.md §4.2 (workspace root).
--
-- A reviewer group is a named set of cuisine identities (leaf rows of restaurant_cuisines).
-- Its score at a restaurant = how reviewers from those backgrounds rate it, computed live from the
-- Rating Model v3 review pool. Stage 1 only creates kind = 'lens', visibility = 'insight';
-- the other values and is_home / legacy_keys are for later stages.
--
-- Access: admin only (functions use the admin secret). Track both tables in Hasura without
-- public/user permissions. Idempotent.

CREATE TABLE IF NOT EXISTS public.reviewer_groups (
  id           serial PRIMARY KEY,
  slug         text NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9-]+$'),
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  description  text,
  kind         text NOT NULL DEFAULT 'lens'    CHECK (kind IN ('map', 'lens')),
  visibility   text NOT NULL DEFAULT 'insight' CHECK (visibility IN ('insight', 'user_facing')),
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  legacy_keys  text[]  NOT NULL DEFAULT '{}',
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reviewer_group_members (
  group_id    integer NOT NULL REFERENCES public.reviewer_groups (id) ON DELETE CASCADE,
  cuisine_id  integer NOT NULL REFERENCES public.restaurant_cuisines (id) ON DELETE CASCADE,
  is_home     boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, cuisine_id)
);

CREATE INDEX IF NOT EXISTS idx_rgm_cuisine ON public.reviewer_group_members (cuisine_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rgm_home ON public.reviewer_group_members (cuisine_id) WHERE is_home;
CREATE INDEX IF NOT EXISTS idx_rg_active ON public.reviewer_groups (is_active, sort_order);

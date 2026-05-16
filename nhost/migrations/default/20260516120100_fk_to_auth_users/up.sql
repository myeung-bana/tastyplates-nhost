-- Phase E-2: Retarget user FKs from restaurant_users(id) to auth.users(id)
-- Run preflight audits from final-deprecation-migration.md §E-2 first (all must return 0 rows).

ALTER TABLE public.restaurant_reviews
  DROP CONSTRAINT IF EXISTS restaurant_reviews_author_id_fkey,
  ADD CONSTRAINT restaurant_reviews_author_id_fkey
    FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.restaurant_review_likes
  DROP CONSTRAINT IF EXISTS restaurant_review_likes_user_id_fkey,
  ADD CONSTRAINT restaurant_review_likes_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.restaurant_review_mentions
  DROP CONSTRAINT IF EXISTS restaurant_review_mentions_mentioned_user_id_fkey,
  ADD CONSTRAINT restaurant_review_mentions_mentioned_user_id_fkey
    FOREIGN KEY (mentioned_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.restaurant_user_follows
  DROP CONSTRAINT IF EXISTS restaurant_user_follows_follower_id_fkey,
  ADD CONSTRAINT restaurant_user_follows_follower_id_fkey
    FOREIGN KEY (follower_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.restaurant_user_follows
  DROP CONSTRAINT IF EXISTS restaurant_user_follows_user_id_fkey,
  ADD CONSTRAINT restaurant_user_follows_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_favorites
  DROP CONSTRAINT IF EXISTS user_favorites_user_id_fkey,
  ADD CONSTRAINT user_favorites_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_checkins
  DROP CONSTRAINT IF EXISTS user_checkins_user_id_fkey,
  ADD CONSTRAINT user_checkins_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

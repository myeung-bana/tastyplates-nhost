-- Phase E-4: Drop legacy restaurant_users table
-- DO NOT RUN until:
--   1. Functions no longer query restaurant_users (ripgrep clean)
--   2. FK audit returns zero references to restaurant_users
--   3. E-2 migration applied and verified in staging

-- Preflight (must return 0 rows):
-- SELECT tc.table_name, kcu.column_name
-- FROM information_schema.table_constraints tc
-- JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
-- JOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)
-- WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'restaurant_users';

DROP TABLE IF EXISTS public.restaurant_users;

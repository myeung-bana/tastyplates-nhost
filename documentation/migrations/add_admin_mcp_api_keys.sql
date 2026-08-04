-- Admin MCP API keys for machine-to-machine access (Claude, Cursor, etc.)
-- Run in Nhost Dashboard → Database → SQL Editor

CREATE TABLE IF NOT EXISTS public.admin_mcp_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL,
  name          text NOT NULL DEFAULT 'Default',
  key_prefix    text NOT NULL,
  key_hash      text NOT NULL,
  scopes        text[] NOT NULL DEFAULT ARRAY['*']::text[],
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_mcp_api_keys_admin_user_id_idx
  ON public.admin_mcp_api_keys (admin_user_id);

CREATE INDEX IF NOT EXISTS admin_mcp_api_keys_key_hash_idx
  ON public.admin_mcp_api_keys (key_hash)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.admin_mcp_api_keys IS
  'Per-admin API keys for MCP / automation clients. Stores SHA-256 hash only; plaintext shown once on create.';

-- Optional: only run if `media_assets` does NOT exist yet.
-- Production Tastyplates already has the legacy table (id uuid PK, s3_key, size_bytes, etc.).
-- Do NOT run add_media_assets.sql on top of legacy — CREATE TABLE IF NOT EXISTS skips required columns.

CREATE TABLE IF NOT EXISTS media_assets (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  s3_bucket           TEXT,
  s3_key              TEXT          NOT NULL,
  public_url          TEXT          NOT NULL,
  sha256              TEXT          NOT NULL,
  etag                TEXT,
  content_type        TEXT          NOT NULL,
  size_bytes          BIGINT        NOT NULL,
  width               INTEGER,
  height              INTEGER,
  original_filename   TEXT,
  uploaded_by_user_id UUID,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_sha256_uq ON media_assets (sha256);
CREATE INDEX IF NOT EXISTS media_assets_created_at_idx ON media_assets (created_at DESC);

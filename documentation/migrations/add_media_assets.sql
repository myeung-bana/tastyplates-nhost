-- media_assets catalog for Nhost Storage uploads (see tastyplates-mobile/documentation/functions/media-upload.md)

CREATE TABLE IF NOT EXISTS media_assets (
  id              BIGSERIAL     PRIMARY KEY,
  uuid            UUID          NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  storage_file_id UUID          UNIQUE,
  public_url      TEXT          NOT NULL,

  s3_key          TEXT,
  s3_bucket       TEXT,

  sha256          TEXT,
  file_size       BIGINT,
  content_type    TEXT,
  original_name   TEXT,

  uploaded_by     UUID,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_sha256
  ON media_assets (sha256) WHERE sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_storage_file_id
  ON media_assets (storage_file_id) WHERE storage_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_uploaded_by
  ON media_assets (uploaded_by) WHERE uploaded_by IS NOT NULL;

CREATE OR REPLACE FUNCTION set_media_assets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_media_assets_updated_at ON media_assets;

CREATE TRIGGER trg_media_assets_updated_at
  BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION set_media_assets_updated_at();

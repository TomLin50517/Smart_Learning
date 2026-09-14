-- =============================================================================
-- 0022_media_assets.sql
-- 課程素材（圖片、影片）：課節的圖片／影片區塊與影片活動以 asset id 引用，不接受外部網址
-- 依據：SD §6.23、§5.1（media/ prefix）、§7.5
-- 相依：0003
-- 權限：0011 的 ALTER DEFAULT PRIVILEGES：app_api 讀寫，其他角色唯讀。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 素材屬於課程（課程的所有版本共用）。檔案本體在物件儲存：
--   {storage_prefix}/media/{org}/{course}/{asset}/original.bin（key 不含檔名）
-- 格式以檔頭判斷，只收瀏覽器能直接顯示的格式；不收 SVG（可夾帶程式碼）。
-- 素材不可變：更換 = 上傳新素材再改引用；被任何課程版本引用時不可刪（服務層檢查）。
-- --------------------------------------------------------------------------
CREATE TABLE media_assets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations(id),
  course_id         uuid        NOT NULL REFERENCES courses(id),
  kind              text        NOT NULL,
  mime_type         text        NOT NULL,
  title             text        NOT NULL,
  original_filename text        NOT NULL,
  size_bytes        bigint      NOT NULL,
  sha256            text        NOT NULL,
  object_key        text        NOT NULL,
  created_by        uuid        REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  CONSTRAINT ck_ma_kind  CHECK (kind IN ('image', 'video')),
  CONSTRAINT ck_ma_mime  CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm')),
  CONSTRAINT ck_ma_match CHECK ((kind = 'image') = (mime_type LIKE 'image/%')),
  CONSTRAINT ck_ma_size  CHECK (size_bytes > 0),
  CONSTRAINT ck_ma_sha   CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_ma_title CHECK (char_length(btrim(title)) BETWEEN 1 AND 200)
);
CREATE INDEX idx_ma_course ON media_assets (course_id, created_at DESC);
CREATE TRIGGER trg_ma_updated BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version) VALUES ('0022_media_assets')
  ON CONFLICT DO NOTHING;

COMMIT;

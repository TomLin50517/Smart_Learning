-- =============================================================================
-- 0020_branding.sql
-- 組織品牌：Logo 與小圖示（小檔案直接存資料庫）、品牌設定格式整理、平台管理員可設定各組織品牌
-- 依據：SD §6.16
-- 相依：0009, 0012
-- 權限：0011 的 ALTER DEFAULT PRIVILEGES 讓 app_api 可讀寫、其他角色唯讀。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Logo（橫式）與小圖示（方形）：每個組織各一張，上限 512 KB。
-- 只收 PNG／JPEG／WebP（以檔頭判斷）；不收 SVG——SVG 可以夾帶程式碼。
-- --------------------------------------------------------------------------
CREATE TABLE organization_assets (
  organization_id uuid        NOT NULL REFERENCES organizations(id),
  kind            text        NOT NULL,
  content_type    text        NOT NULL,
  data            bytea       NOT NULL,
  sha256          text        NOT NULL,
  byte_size       integer     NOT NULL,
  updated_by      uuid        REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind),
  CONSTRAINT ck_oa_kind CHECK (kind IN ('logo', 'icon')),
  CONSTRAINT ck_oa_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT ck_oa_size CHECK (byte_size BETWEEN 1 AND 524288 AND byte_size = octet_length(data)),
  CONSTRAINT ck_oa_sha  CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

-- --------------------------------------------------------------------------
-- 品牌設定改為 { theme, customColor?, platformName? }：舊的 primaryColor 轉為自訂主色；
-- logoAssetId 從未使用，移除。
-- --------------------------------------------------------------------------
UPDATE organizations
   SET branding = (branding - 'primaryColor' - 'logoAssetId')
                  || CASE WHEN branding ? 'primaryColor' THEN jsonb_build_object('customColor', branding->'primaryColor') ELSE '{}'::jsonb END
 WHERE branding ?| ARRAY['primaryColor', 'logoAssetId'];

-- --------------------------------------------------------------------------
-- 平台管理員可替各組織設定品牌（使用者需求；組織管理員原本就可以）
-- --------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'platform_admin' AND p.code = 'org.settings.write'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('0020_branding')
  ON CONFLICT DO NOTHING;

COMMIT;

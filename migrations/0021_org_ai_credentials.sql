-- =============================================================================
-- 0021_org_ai_credentials.sql
-- 各組織的 AI gateway 虛擬金鑰（LiteLLM）：加密後存放，只能寫入、不能讀出
-- 依據：SD §6.22、ADR-034
-- 相依：0009
-- 權限：只有 app_api 能讀寫（設定、以及呼叫 gateway 時解密）。
--       app_coach／app_worker／app_readonly 一律不能讀——即使內容已加密也不給（縱深防禦）。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 金鑰以 AES-256-GCM 加密；主金鑰只在環境變數（AI_KEY_ENCRYPTION_KEY），不進資料庫。
-- 加密時以 organization_id 作為附加驗證資料（AAD）：把某組織的密文搬到另一個組織會解不開。
-- key_alias：金鑰代號（例如 LiteLLM 的 key alias），組織管理員看得到；金鑰本身誰都讀不出來。
-- key_version：主金鑰版本，供日後輪替。
-- --------------------------------------------------------------------------
CREATE TABLE organization_ai_credentials (
  organization_id uuid        PRIMARY KEY REFERENCES organizations(id),
  key_alias       text        NOT NULL,
  ciphertext      bytea       NOT NULL,
  iv              bytea       NOT NULL,
  auth_tag        bytea       NOT NULL,
  key_version     smallint    NOT NULL DEFAULT 1,
  updated_by      uuid        REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_oac_alias CHECK (char_length(btrim(key_alias)) BETWEEN 1 AND 100),
  CONSTRAINT ck_oac_iv    CHECK (octet_length(iv) = 12),
  CONSTRAINT ck_oac_tag   CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT ck_oac_ct    CHECK (octet_length(ciphertext) BETWEEN 1 AND 4096)
);

-- 0011 的 ALTER DEFAULT PRIVILEGES 讓所有角色都能 SELECT 新表；這張表收回
REVOKE ALL ON organization_ai_credentials FROM app_coach, app_worker, app_readonly;

INSERT INTO schema_migrations (version) VALUES ('0021_org_ai_credentials')
  ON CONFLICT DO NOTHING;

COMMIT;

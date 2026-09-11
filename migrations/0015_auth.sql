-- =============================================================================
-- 0015_auth.sql
-- 認證所需：session 閒置逾時、密碼重設 token、流量限制計數
-- 依據：SD §8.1（認證）、§8.8（流量限制）
-- 相依：0002, 0011（角色需已存在，以便收回權限）
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- user_sessions：閒置逾時（SD §8.1：閒置 30 分鐘失效）
-- 絕對到期由 expires_at 表示；refresh 會輪替 token 但不延長絕對到期。
-- --------------------------------------------------------------------------
ALTER TABLE user_sessions
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- session token 雜湊只有 api 需要讀取（縱深防禦：coach / 報表角色不需要）
REVOKE SELECT ON user_sessions FROM app_coach, app_readonly;

-- --------------------------------------------------------------------------
-- password_reset_tokens：一次性 token，只存 SHA-256 雜湊（SD §8.1）
-- --------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_prt_hash CHECK (char_length(token_hash) = 64)
);
CREATE UNIQUE INDEX uq_prt_hash ON password_reset_tokens (token_hash);
CREATE INDEX idx_prt_user_open ON password_reset_tokens (user_id) WHERE used_at IS NULL;

-- 0011 的 ALTER DEFAULT PRIVILEGES 會讓所有角色自動可讀新表；此表只給 api
REVOKE ALL ON password_reset_tokens FROM app_coach, app_worker, app_readonly;

-- --------------------------------------------------------------------------
-- rate_limit_counters：固定時間窗計數（SD §8.8，以 PostgreSQL 取代 Redis）
-- UNLOGGED：不寫 WAL，當機後計數歸零——對流量限制而言可接受，換取寫入效能。
-- bucket 內的帳號識別一律先雜湊，不存 email 原文或攻擊者輸入的任意字串。
-- --------------------------------------------------------------------------
CREATE UNLOGGED TABLE rate_limit_counters (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX idx_rlc_window ON rate_limit_counters (window_start);

REVOKE ALL ON rate_limit_counters FROM app_coach, app_worker, app_readonly;

INSERT INTO schema_migrations (version) VALUES ('0015_auth')
  ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- 0011_db_roles.sql
-- 資料庫角色與最小權限（寬讀、窄寫）
-- 依據：SD v1.1 §8.6、ADR-026
-- 相依：0001–0010（所有表必須已存在）
-- =============================================================================
--
-- 設計原則（§8.6.1）：
--   這些角色要防的是「寫入」，不是「讀取」。跨學員的讀取限制由應用層查詢
--   負責（PersonalLearningContextProvider 的 WHERE user_id 條件）。
--
--   因此授權形狀為 broad SELECT + narrow write，而非白名單列舉可讀的表：
--   白名單會讓「日後多讀一張表」在正式環境炸權限錯誤，而讀取本來就不是
--   要防的東西。搭配 ALTER DEFAULT PRIVILEGES，未來新增的表自動可讀但
--   不自動可寫。
--
-- 執行前請以 psql 變數提供密碼：
--   psql -v api_pw="'...'" -v coach_pw="'...'" \
--        -v worker_pw="'...'" -v ro_pw="'...'" -f 0011_db_roles.sql
-- =============================================================================

BEGIN;

-- ===========================================================================
-- app_api：一般業務
-- ===========================================================================
CREATE ROLE app_api LOGIN PASSWORD :api_pw;
GRANT USAGE ON SCHEMA public TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_api;

-- audit_logs append-only（NFR-SEC-005 / AC-AUD-002）
REVOKE UPDATE, DELETE ON audit_logs FROM app_api;
-- learning_results append-only（INV-6；觸發器為第一層，權限為第二層）
REVOKE UPDATE, DELETE ON learning_results FROM app_api;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_api;

-- ===========================================================================
-- app_coach：AI Coach 同步路徑
--
-- INV-3「AI 不判分」的連線層保證。即使程式碼被誤改為嘗試寫入成績，
-- 資料庫仍會拒絕——這讓 ARCH §1.2 與 ADR-005 不只是程式碼約定。
-- ===========================================================================
CREATE ROLE app_coach LOGIN PASSWORD :coach_pw;
GRANT USAGE ON SCHEMA public TO app_coach;

-- 寬讀：Coach 需要組 context，讀取範圍會隨功能演進
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_coach;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_coach;

-- 窄寫：只有 Coach 自己的五張表
GRANT INSERT ON coach_conversations, coach_messages, coach_citations,
                ai_usage_records, learning_events TO app_coach;

-- 欄位級 UPDATE：只能更新統計欄位。
-- 刻意不含 transcript_visibility——該戳印由 ADR-028 條件 4 保護。
GRANT UPDATE (last_message_at, message_count) ON coach_conversations TO app_coach;
GRANT UPDATE (opened_count) ON coach_citations TO app_coach;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_coach;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_coach;

-- 明確不授予：learning_results / enrollments / certificates 的任何寫入。
-- 驗證見 tests/integration/coach/db-permission.spec.ts 與 SEC-15。

-- ===========================================================================
-- app_worker：非同步 job
-- ===========================================================================
CREATE ROLE app_worker LOGIN PASSWORD :worker_pw;
GRANT USAGE ON SCHEMA public TO app_worker;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_worker;

GRANT INSERT, UPDATE, DELETE ON job_queue, failed_jobs TO app_worker;
GRANT INSERT, UPDATE ON source_documents, document_versions,
                        knowledge_chunk_manifest,
                        derived_knowledge, derived_knowledge_versions,
                        certificates, notifications TO app_worker;
GRANT INSERT ON learning_events, ai_usage_records, audit_logs TO app_worker;

-- retention job 的匿名化需要這兩個欄位
GRANT UPDATE (anonymized_at) ON coach_conversations TO app_worker;
GRANT UPDATE (content) ON coach_messages TO app_worker;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_worker;

-- 明確不授予：learning_results、enrollments、user_org_roles、licenses 的寫入。
-- 完成判定與註冊狀態變更只在 API 路徑發生。

-- ===========================================================================
-- app_readonly：報表 / 稽核
-- ===========================================================================
CREATE ROLE app_readonly LOGIN PASSWORD :ro_pw;
GRANT USAGE ON SCHEMA public TO app_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_readonly;

INSERT INTO schema_migrations (version) VALUES ('0011_db_roles')
  ON CONFLICT DO NOTHING;

COMMIT;

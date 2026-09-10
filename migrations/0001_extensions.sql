-- =============================================================================
-- 0001_extensions.sql
-- Interactive AI Coach System — Extensions, Enums, Shared Functions
-- 依據：SD v1.1 §2.1
-- =============================================================================
-- 執行順序：第一個。所有後續 migration 皆依賴本檔的 enum 與函式。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- 大小寫不敏感 email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- 管理端模糊搜尋
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------
CREATE TYPE scope_type            AS ENUM ('platform','organization','course','self');
CREATE TYPE entity_status         AS ENUM ('active','disabled');
CREATE TYPE course_status         AS ENUM ('draft','active','archived');
CREATE TYPE course_version_status AS ENUM ('draft','review','published','superseded','archived');
CREATE TYPE enrollment_status     AS ENUM ('pending','active','suspended','completed','reopened','withdrawn','rejected');
CREATE TYPE attempt_status        AS ENUM ('in_progress','submitted','scored','abandoned');
CREATE TYPE result_status         AS ENUM ('passed','completed','needs_improvement','failed');
CREATE TYPE document_status       AS ENUM ('uploaded','scanning','rejected','parsing','chunking','indexing','ready','failed','superseded','retired');
CREATE TYPE derived_status        AS ENUM ('auto_generated','teacher_edited','verified','rejected','retired');
CREATE TYPE evidence_status       AS ENUM ('grounded','insufficient_evidence');
CREATE TYPE certificate_status    AS ENUM ('pending','valid','revoked','expired','failed');
CREATE TYPE license_type          AS ENUM ('subscription','perpetual','trial','evaluation_extension');
CREATE TYPE license_state         AS ENUM ('unlicensed','active','grace','frozen','blocked');

-- license_state 刻意不作為任何欄位的型別：授權狀態由 computeCapabilities()
-- 於執行期依 license + activation + 當下時間推導（SD §8.4.1），不持久化。
-- 保留此型別是為了讓應用層與 SD §7.7 的狀態機共用同一組值。
CREATE TYPE job_status            AS ENUM ('pending','running','succeeded','failed','dead');
CREATE TYPE coach_role            AS ENUM ('system','user','assistant');
CREATE TYPE coach_trigger         AS ENUM ('learner_question','result_trigger','relearning_review','course_summary','instructor_test');

-- ADR-028：Coach 逐字稿可見性。於對話建立時戳印，之後不可變。
CREATE TYPE transcript_visibility AS ENUM ('aggregate_only','course_staff');

-- --------------------------------------------------------------------------
-- Shared trigger functions
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE 觸發器：自動維護 updated_at。';

-- Append-only 保護。
-- 刻意使用 RAISE 而非 RULE ... DO INSTEAD NOTHING：
-- 靜默忽略寫入會讓呼叫端誤以為成功，違反「如實回報結果」原則。
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % 不允許 % 操作', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reject_mutation() IS
  'append-only 表的 BEFORE UPDATE OR DELETE 觸發器（INV-6 / NFR-SEC-005）。';

-- --------------------------------------------------------------------------
-- Migration registry
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('0001_extensions')
  ON CONFLICT DO NOTHING;

COMMIT;

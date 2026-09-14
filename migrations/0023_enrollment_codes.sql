-- =============================================================================
-- 0023_enrollment_codes.sql
-- 選課碼：課程的 enrollment_policy.code 在同一組織內唯一、格式固定
-- 依據：SD §6.24、SA UC-ENR-002／003／004
-- 相依：0003
-- =============================================================================

BEGIN;

-- 8 碼，不含容易看錯的 0／O、1／I；由伺服器產生（使用者不能自訂）
ALTER TABLE courses ADD CONSTRAINT ck_courses_enroll_code
  CHECK (enrollment_policy->>'code' IS NULL OR enrollment_policy->>'code' ~ '^[A-HJ-NP-Z2-9]{8}$');

-- 學員輸入選課碼時，在自己所在的組織內找課程——同一組織內不能重複
CREATE UNIQUE INDEX uq_courses_enroll_code ON courses (organization_id, (enrollment_policy->>'code'))
  WHERE enrollment_policy->>'code' IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('0023_enrollment_codes')
  ON CONFLICT DO NOTHING;

COMMIT;

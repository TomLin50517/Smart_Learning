-- =============================================================================
-- 0019_cohorts.sql
-- 學號／員工編號與班級（梯次）：組織內的成員資料
-- 依據：SD §6.15
-- 相依：0002, 0005, 0018
-- 權限：0011 的 ALTER DEFAULT PRIVILEGES 讓 app_api 可讀寫、其他角色唯讀。
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 成員在組織內的資料：學號／員工編號不隨學年改變，只在本組織有意義
-- （同一人在不同組織可以有不同編號）。成員資格本身仍由 user_org_roles 決定。
-- --------------------------------------------------------------------------
CREATE TABLE member_profiles (
  organization_id uuid        NOT NULL REFERENCES organizations(id),
  user_id         uuid        NOT NULL REFERENCES users(id),
  member_no       text,
  updated_by      uuid        REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT ck_mp_member_no CHECK (member_no IS NULL OR char_length(member_no) BETWEEN 1 AND 64)
);
-- 同一組織內學號不可重複
CREATE UNIQUE INDEX uq_mp_member_no ON member_profiles (organization_id, member_no) WHERE member_no IS NOT NULL;
CREATE INDEX ix_member_profiles_user ON member_profiles (user_id);

-- --------------------------------------------------------------------------
-- 班級／梯次：每學年（每期）建新的，舊的封存不刪除
-- --------------------------------------------------------------------------
CREATE TABLE cohorts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations(id),
  name            text        NOT NULL,
  term            text,
  status          text        NOT NULL DEFAULT 'active',
  created_by      uuid        REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  archived_at     timestamptz,
  CONSTRAINT ck_cohort_name     CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT ck_cohort_term     CHECK (term IS NULL OR char_length(term) BETWEEN 1 AND 50),
  CONSTRAINT ck_cohort_status   CHECK (status IN ('active', 'archived')),
  CONSTRAINT ck_cohort_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
-- 使用中的班級名稱在組織內不可重複；封存的可以同名（例如每年都有「三年二班」）
CREATE UNIQUE INDEX uq_cohort_active_name ON cohorts (organization_id, lower(name)) WHERE status = 'active';
CREATE INDEX ix_cohorts_org ON cohorts (organization_id, status);
CREATE TRIGGER trg_cohorts_updated BEFORE UPDATE ON cohorts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 班級成員：一人可在多個班級；封存班級的成員紀錄保留（歷史）
CREATE TABLE cohort_members (
  cohort_id       uuid        NOT NULL REFERENCES cohorts(id),
  user_id         uuid        NOT NULL REFERENCES users(id),
  organization_id uuid        NOT NULL REFERENCES organizations(id),
  added_by        uuid        REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cohort_id, user_id)
);
CREATE INDEX ix_cohort_members_user ON cohort_members (organization_id, user_id);

-- --------------------------------------------------------------------------
-- 選課時的班級（快照）：學員日後換班，舊課程仍顯示當時的班級
-- --------------------------------------------------------------------------
ALTER TABLE enrollments ADD COLUMN cohort_label text;

INSERT INTO schema_migrations (version) VALUES ('0019_cohorts')
  ON CONFLICT DO NOTHING;

COMMIT;

-- =============================================================================
-- 0005_learning.sql
-- Enrollment / Attempt / Result / Event
-- 依據：SD v1.1 §2.4、SA v1.1 §7.2、§7.3、§11.3.3
-- 相依：0003
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- enrollments
-- --------------------------------------------------------------------------
CREATE TABLE enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  course_id         uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status            enrollment_status NOT NULL DEFAULT 'active',
  enroll_method     text NOT NULL,
  assigned_by       uuid REFERENCES users(id),
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  withdrawn_at      timestamptz,
  due_date          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  CONSTRAINT ck_enr_method CHECK (enroll_method IN ('assign','self','code','approval')),
  CONSTRAINT ck_enr_completed CHECK
    (status <> 'completed' OR completed_at IS NOT NULL)
);
-- 同一課程同一學員至多一筆「有效」註冊（SA §7.2）
CREATE UNIQUE INDEX uq_enr_active ON enrollments (course_id, user_id)
  WHERE status NOT IN ('withdrawn','rejected');
CREATE INDEX idx_enr_org_course_status ON enrollments (organization_id, course_id, status);
CREATE INDEX idx_enr_user ON enrollments (user_id, status);
CREATE INDEX idx_enr_cv ON enrollments (course_version_id);
CREATE TRIGGER trg_enr_updated BEFORE UPDATE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- learning_attempts
-- --------------------------------------------------------------------------
CREATE TABLE learning_attempts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  enrollment_id            uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  activity_id              uuid NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  attempt_no               integer NOT NULL,
  status                   attempt_status NOT NULL DEFAULT 'in_progress',
  relearning_assignment_id uuid,          -- FK 於 0006 補（循環相依）
  started_at               timestamptz NOT NULL DEFAULT now(),
  submitted_at             timestamptz,
  scored_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz,
  CONSTRAINT ck_att_no CHECK (attempt_no >= 1)
);
CREATE UNIQUE INDEX uq_att_enr_act_no
  ON learning_attempts (enrollment_id, activity_id, attempt_no);
-- 同一活動同時只允許一個進行中的 attempt（SA §7.3）
CREATE UNIQUE INDEX uq_att_single_in_progress
  ON learning_attempts (enrollment_id, activity_id)
  WHERE status = 'in_progress';
CREATE INDEX idx_att_enr ON learning_attempts (enrollment_id);
CREATE TRIGGER trg_att_updated BEFORE UPDATE ON learning_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- learning_results — append-only（INV-6）
-- evaluator 欄位記錄產生此結果的 server evaluator，確保可追溯（ADR-024）
-- --------------------------------------------------------------------------
CREATE TABLE learning_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  attempt_id      uuid NOT NULL REFERENCES learning_attempts(id) ON DELETE CASCADE,
  enrollment_id   uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  activity_id     uuid NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  status          result_status NOT NULL,
  score           numeric(8,2),
  max_score       numeric(8,2) NOT NULL,
  issues          jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback_data   jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluator       text NOT NULL,
  evaluated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_lr_score CHECK (score IS NULL OR (score >= 0 AND score <= max_score))
);
CREATE UNIQUE INDEX uq_lr_attempt ON learning_results (attempt_id);
CREATE INDEX idx_lr_enr_activity ON learning_results (enrollment_id, activity_id);
CREATE INDEX idx_lr_issues ON learning_results USING gin (issues jsonb_path_ops);

-- append-only：以 RAISE 而非靜默忽略（見 0001 reject_mutation 註解）
CREATE TRIGGER trg_lr_append_only
  BEFORE UPDATE OR DELETE ON learning_results
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- --------------------------------------------------------------------------
-- learning_events — 月分區（ADR-022）
-- 刻意不設 FK（ADR-027）：高頻寫入下 FK 檢查會對參照表產生額外鎖與 IO。
-- 歸屬正確性由 ingest 服務保證（server 覆寫身分欄位，ADR-021），
-- 並由一致性檢查腳本（SA §16.4）定期驗證。
-- --------------------------------------------------------------------------
CREATE TABLE learning_events (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL,             -- client 產生，冪等鍵
  event_type        text NOT NULL,
  event_version     text NOT NULL DEFAULT '1.0',
  organization_id   uuid NOT NULL,
  course_id         uuid NOT NULL,
  course_version_id uuid NOT NULL,
  enrollment_id     uuid NOT NULL,
  learner_id        uuid NOT NULL,
  activity_id       uuid,
  attempt_id        uuid,
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  clock_skew_ms     integer,
  correlation_id    text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE learning_events_default PARTITION OF learning_events DEFAULT;

CREATE UNIQUE INDEX uq_le_event_id ON learning_events (event_id, occurred_at);
CREATE INDEX idx_le_enr_time  ON learning_events (enrollment_id, occurred_at DESC);
CREATE INDEX idx_le_type_time ON learning_events (event_type, occurred_at DESC);
CREATE INDEX idx_le_org_time  ON learning_events (organization_id, occurred_at DESC);
CREATE INDEX idx_le_attempt   ON learning_events (attempt_id) WHERE attempt_id IS NOT NULL;

-- 實際月分區由 0014 與 partition.maintenance job 建立

INSERT INTO schema_migrations (version) VALUES ('0005_learning')
  ON CONFLICT DO NOTHING;

COMMIT;

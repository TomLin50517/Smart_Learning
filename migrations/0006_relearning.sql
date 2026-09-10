-- =============================================================================
-- 0006_relearning.sql
-- Relearning / ProgressSnapshot / CompletionApproval
-- 依據：SD v1.1 §2.4、SA v1.1 §9、INV-6
-- 相依：0005
-- =============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- relearning_assignments
-- preserve_old_result 以 CHECK 鎖死為 true：MVP 不允許覆寫歷史（INV-6）
-- --------------------------------------------------------------------------
CREATE TABLE relearning_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  enrollment_id       uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  scope_type          text NOT NULL,
  scope_id            uuid,
  reason              text NOT NULL,
  assigned_by         uuid NOT NULL REFERENCES users(id),
  due_date            timestamptz,
  preserve_old_result boolean NOT NULL DEFAULT true,
  new_attempt_policy  text NOT NULL DEFAULT 'append',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_rla_scope CHECK (scope_type IN ('course','module','lesson','activity')),
  CONSTRAINT ck_rla_scope_id CHECK
    ((scope_type = 'course' AND scope_id IS NULL) OR
     (scope_type <> 'course' AND scope_id IS NOT NULL)),
  CONSTRAINT ck_rla_policy CHECK (new_attempt_policy IN ('append','reset_counter')),
  CONSTRAINT ck_rla_preserve CHECK (preserve_old_result = true)
);
CREATE INDEX idx_rla_enr ON relearning_assignments (enrollment_id, created_at DESC);

ALTER TABLE learning_attempts
  ADD CONSTRAINT fk_att_relearning
  FOREIGN KEY (relearning_assignment_id) REFERENCES relearning_assignments(id);

-- --------------------------------------------------------------------------
-- progress_snapshots（只保留最新一筆；completion_evaluation 存 SD §3.5 的 trace）
-- --------------------------------------------------------------------------
CREATE TABLE progress_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  enrollment_id         uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  required_total        integer NOT NULL,
  required_completed    integer NOT NULL,
  weighted_score        numeric(8,2),
  completion_evaluation jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ck_ps_counts CHECK (required_completed >= 0 AND required_completed <= required_total)
);
CREATE UNIQUE INDEX uq_ps_enr ON progress_snapshots (enrollment_id);

-- --------------------------------------------------------------------------
-- completion_approvals（manual_approval 條件的資料來源）
-- --------------------------------------------------------------------------
CREATE TABLE completion_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  approver_role text NOT NULL,
  approved_by   uuid NOT NULL REFERENCES users(id),
  approved_at   timestamptz NOT NULL DEFAULT now(),
  note          text
);
CREATE INDEX idx_ca_enr ON completion_approvals (enrollment_id);

INSERT INTO schema_migrations (version) VALUES ('0006_relearning')
  ON CONFLICT DO NOTHING;

COMMIT;

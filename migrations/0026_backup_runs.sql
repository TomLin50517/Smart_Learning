-- =============================================================================
-- 0026_backup_runs.sql
-- 備份紀錄（SA UC-PLT-008、§16；SD §6.28）
--   * 每日備份由 compose 的 backup 服務執行；平台管理員可插入 status='requested' 手動觸發
--   * 只記結果與位置，不含任何祕密
-- =============================================================================

CREATE TABLE backup_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'requested',
  requested_by    uuid REFERENCES users(id),
  started_at      timestamptz,
  finished_at     timestamptz,
  database_bytes  bigint,
  object_files    integer,
  object_bytes    bigint,
  location        text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_bkp_kind CHECK (kind IN ('daily', 'manual')),
  CONSTRAINT ck_bkp_status CHECK (status IN ('requested', 'running', 'succeeded', 'failed'))
);
CREATE INDEX idx_bkp_created ON backup_runs (created_at DESC);
-- 取件用：等待中的手動備份
CREATE INDEX idx_bkp_requested ON backup_runs (created_at) WHERE status = 'requested';

INSERT INTO schema_migrations (version) VALUES ('0026_backup_runs') ON CONFLICT DO NOTHING;

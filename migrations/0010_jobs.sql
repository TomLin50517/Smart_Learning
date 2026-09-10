-- =============================================================================
-- 0010_jobs.sql
-- PostgreSQL-backed Job Queue（ADR-011：MVP 不引入 Redis）
-- 依據：SD v1.1 §2.8、§11
-- 相依：0001
-- =============================================================================

BEGIN;

CREATE TABLE job_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type        text NOT NULL,
  queue           text NOT NULL DEFAULT 'default',   -- ingest | ai | output
  priority        smallint NOT NULL DEFAULT 100,     -- 小者先執行
  payload         jsonb NOT NULL,
  idempotency_key text,
  status          job_status NOT NULL DEFAULT 'pending',
  run_after       timestamptz NOT NULL DEFAULT now(),
  attempts        smallint NOT NULL DEFAULT 0,
  max_attempts    smallint NOT NULL DEFAULT 5,
  locked_by       text,
  locked_at       timestamptz,
  lock_expires_at timestamptz,
  last_error      text,
  organization_id uuid,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  CONSTRAINT ck_jq_queue CHECK (queue IN ('ingest','ai','output','default')),
  CONSTRAINT ck_jq_attempts CHECK (attempts >= 0 AND attempts <= max_attempts + 1)
);
CREATE UNIQUE INDEX uq_jq_idempotency ON job_queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jq_claim ON job_queue (queue, status, priority, run_after)
  WHERE status = 'pending';
CREATE INDEX idx_jq_stale_lock ON job_queue (lock_expires_at)
  WHERE status = 'running';
CREATE TRIGGER trg_jq_updated BEFORE UPDATE ON job_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Dead letter queue
CREATE TABLE failed_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id uuid NOT NULL,
  job_type        text NOT NULL,
  queue           text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        smallint NOT NULL,
  error_detail    text NOT NULL,
  organization_id uuid,
  correlation_id  text,
  failed_at       timestamptz NOT NULL DEFAULT now(),
  requeued_at     timestamptz
);
CREATE INDEX idx_fj_type_time ON failed_jobs (job_type, failed_at DESC);

-- --------------------------------------------------------------------------
-- 取件：唯一允許的方式（SD §2.8）
-- FOR UPDATE SKIP LOCKED 讓多個 worker replica 不互相阻塞。
-- --------------------------------------------------------------------------
COMMENT ON TABLE job_queue IS
$$取件查詢（唯一允許的方式）：

UPDATE job_queue
   SET status = 'running',
       locked_by = $1,
       locked_at = now(),
       lock_expires_at = now() + ($2 || ' seconds')::interval,
       attempts = attempts + 1,
       updated_at = now()
 WHERE id = (
   SELECT id FROM job_queue
    WHERE status = 'pending'
      AND run_after <= now()
      AND queue = ANY($3::text[])
    ORDER BY priority, run_after
    FOR UPDATE SKIP LOCKED
    LIMIT 1
 )
RETURNING *;

逾時鎖回收（每分鐘）：

UPDATE job_queue
   SET status='pending', locked_by=NULL, locked_at=NULL, lock_expires_at=NULL
 WHERE status='running' AND lock_expires_at < now();$$;

INSERT INTO schema_migrations (version) VALUES ('0010_jobs')
  ON CONFLICT DO NOTHING;

COMMIT;

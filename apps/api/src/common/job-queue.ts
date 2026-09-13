import type pg from 'pg';

/** 背景工作（SD §11）的排入規格 */
export interface JobSpec {
  jobType: string;
  queue: 'ingest' | 'ai' | 'output' | 'default';
  payload: Record<string, unknown>;
  /** 相同 key 只會排入一次（uq_jq_idempotency） */
  idempotencyKey?: string;
  priority?: number;
  maxAttempts?: number;
  organizationId?: string | null;
  correlationId?: string | null;
}

/**
 * 在呼叫端的交易內排入工作：業務寫入復原時工作一起消失，提交後 worker 才看得到。
 * 回傳是否真的排入（同一 idempotency key 已存在時為 false）。
 */
export async function enqueueJobTx(c: pg.PoolClient, j: JobSpec): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO job_queue (job_type, queue, priority, max_attempts, payload, idempotency_key, organization_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [j.jobType, j.queue, j.priority ?? 100, j.maxAttempts ?? 5, JSON.stringify(j.payload), j.idempotencyKey ?? null, j.organizationId ?? null, j.correlationId ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

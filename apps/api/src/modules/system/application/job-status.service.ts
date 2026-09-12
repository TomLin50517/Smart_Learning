import { Inject, Injectable } from '@nestjs/common';
import type { JobQueueStatus } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';

const RECENT_DEAD = 20;
const ERROR_MAX = 500;

/**
 * 背景工作佇列狀態（SD §8.11、SA §18.2 Job 指標）。只讀；重送 DLQ 等操作屬後續項目。
 * succeeded 只統計最近 24 小時——完成的工作會留在 job_queue，全量計數沒有意義。
 */
@Injectable()
export class JobStatusService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async status(): Promise<JobQueueStatus> {
    const [queues, stale, deadTotal, dead] = await Promise.all([
      this.db.query<{ queue: string; job_type: string; pending: number; running: number; succeeded_24h: number; oldest: number | null }>(
        `SELECT queue, job_type,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                count(*) FILTER (WHERE status = 'succeeded' AND updated_at > now() - interval '24 hours')::int AS succeeded_24h,
                extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'pending' AND run_after <= now()))::float8 AS oldest
           FROM job_queue
          WHERE status IN ('pending', 'running') OR (status = 'succeeded' AND updated_at > now() - interval '24 hours')
          GROUP BY queue, job_type
          ORDER BY queue, job_type`,
      ),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_queue WHERE status = 'running' AND lock_expires_at < now()`),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM failed_jobs WHERE requeued_at IS NULL`),
      this.db.query<{
        id: string;
        job_type: string;
        queue: string;
        attempts: number;
        failed_at: Date;
        error_detail: string;
        organization_id: string | null;
        correlation_id: string | null;
      }>(
        `SELECT id, job_type, queue, attempts, failed_at, error_detail, organization_id, correlation_id
           FROM failed_jobs WHERE requeued_at IS NULL ORDER BY failed_at DESC LIMIT ${RECENT_DEAD}`,
      ),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      queues: queues.rows.map((r) => ({
        queue: r.queue,
        jobType: r.job_type,
        pending: r.pending,
        running: r.running,
        succeeded24h: r.succeeded_24h,
        oldestPendingSeconds: r.oldest === null ? null : Math.max(0, Math.round(r.oldest)),
      })),
      staleLocks: stale.rows[0]?.n ?? 0,
      deadLetters: {
        total: deadTotal.rows[0]?.n ?? 0,
        recent: dead.rows.map((r) => ({
          id: r.id,
          jobType: r.job_type,
          queue: r.queue,
          attempts: r.attempts,
          failedAt: r.failed_at.toISOString(),
          error: r.error_detail.length > ERROR_MAX ? `${r.error_detail.slice(0, ERROR_MAX)}…` : r.error_detail,
          organizationId: r.organization_id,
          correlationId: r.correlation_id,
        })),
      },
    };
  }
}

import type pg from 'pg';
import type { Logger } from 'pino';
import { FatalError, onFailure } from './retry-policy.js';

export interface Job {
  id: string;
  job_type: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  organization_id: string | null;
  correlation_id: string | null;
}

export interface JobHandler {
  readonly jobType: string;
  readonly timeoutMs: number;
  /** 必須冪等：同一 payload 重複執行不得產生重複副作用（SD §11.3） */
  handle(job: Job): Promise<void>;
}

export interface DispatcherOptions {
  workerId: string;
  queues: string[];
  pollIntervalMs?: number;
  lockSeconds?: number;
}

/** SD §2.8 的取件查詢——唯一允許的取件方式；SKIP LOCKED 讓多個 replica 不互相阻塞 */
const CLAIM_SQL = `
UPDATE job_queue
   SET status = 'running', locked_by = $1, locked_at = now(),
       lock_expires_at = now() + ($2 || ' seconds')::interval,
       attempts = attempts + 1, updated_at = now()
 WHERE id = (
   SELECT id FROM job_queue
    WHERE status = 'pending' AND run_after <= now() AND queue = ANY($3::text[])
    ORDER BY priority, run_after
    FOR UPDATE SKIP LOCKED
    LIMIT 1)
RETURNING id, job_type, queue, payload, attempts, max_attempts, organization_id, correlation_id`;

const RECLAIM_SQL = `
UPDATE job_queue
   SET status = 'pending', locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
 WHERE status = 'running' AND lock_expires_at < now()`;

export class Dispatcher {
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;
  private current: Promise<void> | null = null;
  private reclaimTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: pg.Pool,
    private readonly log: Logger,
    private readonly opts: DispatcherOptions,
  ) {}

  register(handler: JobHandler): this {
    this.handlers.set(handler.jobType, handler);
    return this;
  }

  async start(): Promise<void> {
    this.running = true;
    this.reclaimTimer = setInterval(() => void this.reclaimStale(), 60_000);
    this.log.info({ queues: this.opts.queues, handlers: [...this.handlers.keys()] }, 'dispatcher started');
    while (this.running) {
      let claimed = false;
      this.current = this.tick().then(
        (c) => {
          claimed = c;
        },
        (err: unknown) => {
          // DB 斷線等錯誤不可靜默吞掉，否則 worker 會「看似存活但什麼都不做」
          this.log.error({ err }, 'dispatcher tick failed');
        },
      );
      await this.current;
      // 取到 job 就立刻取下一件；閒置或出錯才等待
      if (this.running && !claimed) await sleep(this.opts.pollIntervalMs ?? 1_000);
    }
  }

  /** 優雅停止：不再取新 job，等目前這個跑完 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    await this.current?.catch(() => undefined);
  }

  /** 取一件並執行；回傳是否有取到 job */
  async tick(): Promise<boolean> {
    const r = await this.db.query<Job>(CLAIM_SQL, [this.opts.workerId, this.opts.lockSeconds ?? 900, this.opts.queues]);
    const job = r.rows[0];
    if (!job) return false;

    const log = this.log.child({ job_id: job.id, job_type: job.job_type, correlation_id: job.correlation_id });
    const handler = this.handlers.get(job.job_type);
    try {
      if (!handler) throw new FatalError(`no handler registered for ${job.job_type} in queues ${this.opts.queues.join(',')}`);
      await withTimeout(handler.handle(job), handler.timeoutMs);
      await this.db.query(`UPDATE job_queue SET status = 'succeeded', locked_by = NULL, updated_at = now() WHERE id = $1`, [job.id]);
      log.info('job succeeded');
    } catch (err) {
      const out = onFailure(err, { attempts: job.attempts, maxAttempts: job.max_attempts }, new Date());
      if (out.kind === 'retry') {
        await this.db.query(
          `UPDATE job_queue SET status = 'pending', locked_by = NULL, run_after = $2, last_error = $3, updated_at = now() WHERE id = $1`,
          [job.id, out.runAfter, String(err)],
        );
        log.warn({ err, run_after: out.runAfter }, 'job failed, will retry');
      } else {
        await this.deadLetter(job, out.reason);
        log.error({ err }, 'job moved to dead letter queue');
      }
    }
    return true;
  }

  private async deadLetter(job: Job, reason: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO failed_jobs (original_job_id, job_type, queue, payload, attempts, error_detail, organization_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [job.id, job.job_type, job.queue, job.payload, job.attempts, reason, job.organization_id, job.correlation_id],
      );
      await client.query(`UPDATE job_queue SET status = 'dead', locked_by = NULL, last_error = $2, updated_at = now() WHERE id = $1`, [
        job.id,
        reason,
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async reclaimStale(): Promise<void> {
    try {
      const r = await this.db.query(RECLAIM_SQL);
      if (r.rowCount) this.log.warn({ count: r.rowCount }, 'reclaimed stale job locks');
    } catch (err) {
      this.log.error({ err }, 'stale lock reclaim failed');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`job timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

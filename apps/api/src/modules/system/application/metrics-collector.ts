import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { logger } from '../../../common/logger.js';
import { metrics, registry } from '../../../common/metrics.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../../license/license.contracts.js';

const DAY_MS = 86_400_000;

/**
 * GET /api/system/metrics 的輸出（SD §13.2）。
 * 請求計數在行程內累計；佇列與授權類的值在抓取時才從 DB 計算，
 * 因此多個 API replica 回報的佇列數字相同（Prometheus 端以 max 彙整即可）。
 *
 * Phase 0 尚未輸出：ES、AI、Coach、儲存用量——對應功能完成時再加入。
 */
@Injectable()
export class MetricsCollector {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
  ) {}

  async render(): Promise<string> {
    await Promise.all([this.collectJobs(), this.collectLicense()]);
    return registry.render();
  }

  private async collectJobs(): Promise<void> {
    try {
      const [depth, oldest, dead] = await Promise.all([
        this.db.query<{ queue: string; job_type: string; n: number }>(
          `SELECT queue, job_type, count(*)::int AS n FROM job_queue WHERE status = 'pending' GROUP BY queue, job_type`,
        ),
        this.db.query<{ queue: string; age: number }>(
          `SELECT queue, extract(epoch FROM now() - min(run_after))::float8 AS age
             FROM job_queue WHERE status = 'pending' AND run_after <= now() GROUP BY queue`,
        ),
        this.db.query<{ job_type: string; n: number }>(
          `SELECT job_type, count(*)::int AS n FROM failed_jobs WHERE requeued_at IS NULL GROUP BY job_type`,
        ),
      ]);
      metrics.jobQueueDepth.reset();
      metrics.jobOldestPending.reset();
      metrics.jobDead.reset();
      for (const r of depth.rows) metrics.jobQueueDepth.set({ queue: r.queue, job_type: r.job_type }, r.n);
      for (const r of oldest.rows) metrics.jobOldestPending.set({ queue: r.queue }, Math.max(0, Math.round(r.age)));
      for (const r of dead.rows) metrics.jobDead.set({ job_type: r.job_type }, r.n);
    } catch (err) {
      // 指標抓取失敗不應讓端點 500：保留上一次的值並記錄
      logger.warn({ err }, 'job metrics collection failed');
    }
  }

  private async collectLicense(): Promise<void> {
    try {
      const e = await this.license.evaluate();
      metrics.licenseDaysRemaining.reset();
      const now = Date.now();
      if (e.expiresAt) metrics.licenseDaysRemaining.set({ kind: 'expiry' }, Math.floor((Date.parse(e.expiresAt) - now) / DAY_MS));
      if (e.maintenanceUntil) {
        metrics.licenseDaysRemaining.set({ kind: 'maintenance' }, Math.floor((Date.parse(e.maintenanceUntil) - now) / DAY_MS));
      }
    } catch (err) {
      logger.warn({ err }, 'license metrics collection failed');
    }
  }
}

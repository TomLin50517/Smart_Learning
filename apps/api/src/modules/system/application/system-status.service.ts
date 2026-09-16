import { Inject, Injectable } from '@nestjs/common';
import { BACKUP_STALE_HOURS, type BackupRunDto, type BackupStatus, type SystemAlertDto, type SystemStatusDto } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { ENV, type Env } from '../../../config/env.js';
import { LICENSE_EVALUATOR, type LicenseEvaluator } from '../../license/license.contracts.js';
import { JobStatusService } from './job-status.service.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 佇列積壓超過 30 分鐘即告警（SA §18.2） */
const OLDEST_WARN_SEC = 1800;
const FALLBACK_WARN = 0.2;
const RECENT_BACKUPS = 20;

interface BackupRow {
  id: string;
  kind: 'daily' | 'manual';
  status: BackupStatus;
  requested_by_name: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  database_bytes: string | null;
  object_files: number | null;
  object_bytes: string | null;
  location: string | null;
  error: string | null;
  created_at: Date;
}

const toBackup = (r: BackupRow): BackupRunDto => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  requestedByName: r.requested_by_name,
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
  databaseBytes: r.database_bytes === null ? null : Number(r.database_bytes),
  objectFiles: r.object_files,
  objectBytes: r.object_bytes === null ? null : Number(r.object_bytes),
  location: r.location,
  error: r.error,
  createdAt: r.created_at.toISOString(),
});

const days = (iso: string | null | undefined): number | null => (iso ? Math.floor((Date.parse(iso) - Date.now()) / DAY_MS) : null);

/**
 * 系統狀態（SA UC-PLT-008／010、§18；SD §6.28）：平台管理員的一頁總覽與備份紀錄。
 * 只讀彙整數字，不含任何學員內容；備份由 compose 的 backup 服務執行，這裡只排隊與回報。
 */
@Injectable()
export class SystemStatusService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(LICENSE_EVALUATOR) private readonly license: LicenseEvaluator,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobStatusService,
  ) {}

  async backups(): Promise<BackupRunDto[]> {
    const r = await this.db.query<BackupRow>(
      `SELECT b.id, b.kind, b.status, u.display_name AS requested_by_name, b.started_at, b.finished_at,
              b.database_bytes, b.object_files, b.object_bytes, b.location, b.error, b.created_at
         FROM backup_runs b LEFT JOIN users u ON u.id = b.requested_by
        ORDER BY b.created_at DESC LIMIT ${RECENT_BACKUPS}`,
    );
    return r.rows.map(toBackup);
  }

  /** 手動備份：排入一筆等待中的紀錄，由 backup 服務取件（已有等待中的就回傳那一筆） */
  async requestBackup(actorId: string): Promise<BackupRunDto> {
    const pending = await this.db.query<BackupRow>(
      `SELECT b.id, b.kind, b.status, u.display_name AS requested_by_name, b.started_at, b.finished_at,
              b.database_bytes, b.object_files, b.object_bytes, b.location, b.error, b.created_at
         FROM backup_runs b LEFT JOIN users u ON u.id = b.requested_by
        WHERE b.status IN ('requested', 'running') ORDER BY b.created_at LIMIT 1`,
    );
    if (pending.rows[0]) throw new DomainError('VALIDATION_FAILED', 'backup_in_progress', [{ issue: 'backup_in_progress' }]);
    const r = await this.db.query<{ id: string }>(`INSERT INTO backup_runs (kind, status, requested_by) VALUES ('manual', 'requested', $1) RETURNING id`, [actorId]);
    const one = await this.db.query<BackupRow>(
      `SELECT b.id, b.kind, b.status, u.display_name AS requested_by_name, b.started_at, b.finished_at,
              b.database_bytes, b.object_files, b.object_bytes, b.location, b.error, b.created_at
         FROM backup_runs b LEFT JOIN users u ON u.id = b.requested_by WHERE b.id = $1`,
      [r.rows[0]!.id],
    );
    return toBackup(one.rows[0]!);
  }

  async status(): Promise<SystemStatusDto> {
    const [jobs, licence, search, ai, storage, backup, learners] = await Promise.all([
      this.jobs.status(),
      this.license.evaluate(),
      this.db.query<{ pending: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('uploaded', 'scanning', 'parsing', 'chunking', 'indexing'))::int AS pending,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM document_versions`,
      ),
      this.db.query<{ requests: number; tokens: string; errors: number; answers: number; fallbacks: number }>(
        `SELECT (SELECT count(*)::int FROM ai_usage_records WHERE occurred_at >= date_trunc('day', now())) AS requests,
                (SELECT COALESCE(sum(total_tokens), 0)::text FROM ai_usage_records WHERE occurred_at >= date_trunc('day', now())) AS tokens,
                (SELECT count(*)::int FROM ai_usage_records WHERE occurred_at >= date_trunc('day', now()) AND status <> 'success') AS errors,
                (SELECT count(*)::int FROM coach_messages WHERE role = 'assistant' AND created_at >= date_trunc('day', now())) AS answers,
                (SELECT count(*)::int FROM coach_messages WHERE role = 'assistant' AND created_at >= date_trunc('day', now()) AND validation_status = 'fallback') AS fallbacks`,
      ),
      this.db.query<{ database_bytes: string; document_bytes: string; media_bytes: string }>(
        `SELECT pg_database_size(current_database())::text AS database_bytes,
                (SELECT COALESCE(sum(size_bytes), 0)::text FROM document_versions) AS document_bytes,
                (SELECT COALESCE(sum(size_bytes), 0)::text FROM media_assets) AS media_bytes`,
      ),
      this.db.query<{ last_succeeded: Date | null; last_status: BackupStatus | null; last_error: string | null }>(
        `SELECT (SELECT max(finished_at) FROM backup_runs WHERE status = 'succeeded') AS last_succeeded,
                (SELECT status FROM backup_runs ORDER BY created_at DESC LIMIT 1) AS last_status,
                (SELECT error FROM backup_runs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 1) AS last_error`,
      ),
      this.license.usage('maxActiveLearners'),
    ]);

    const queue = jobs.queues.reduce(
      (acc, q) => ({
        pending: acc.pending + q.pending,
        running: acc.running + q.running,
        oldest: Math.max(acc.oldest, q.oldestPendingSeconds ?? 0),
      }),
      { pending: 0, running: 0, oldest: 0 },
    );
    const a = ai.rows[0]!;
    const s = storage.rows[0]!;
    const b = backup.rows[0]!;
    const answers = a.answers;
    const fallbackRatio = answers > 0 ? Math.round((a.fallbacks / answers) * 100) / 100 : null;
    const ageHours = b.last_succeeded ? Math.floor((Date.now() - b.last_succeeded.getTime()) / HOUR_MS) : null;
    const tokensToday = Number(a.tokens);
    const expiryDays = days(licence.expiresAt);
    const maintenanceDays = days(licence.maintenanceUntil);

    const alerts: SystemAlertDto[] = [];
    const add = (key: string, level: SystemAlertDto['level'], message: string) => alerts.push({ key, level, message });
    if (jobs.deadLetters.total > 0) add('jobs.dead', 'critical', `有 ${jobs.deadLetters.total} 個背景工作重試失敗後已放棄，請到「背景工作」查看原因。`);
    if (queue.oldest > OLDEST_WARN_SEC) add('jobs.backlog', 'warning', `背景工作積壓：最久的一件已等待 ${Math.floor(queue.oldest / 60)} 分鐘。`);
    if (jobs.staleLocks > 0) add('jobs.stale', 'warning', `有 ${jobs.staleLocks} 個工作的鎖已過期（worker 可能中斷過），下次取件時會自動回收。`);
    if (b.last_status === 'failed') add('backup.failed', 'critical', `最近一次備份失敗：${(b.last_error ?? '').slice(0, 200)}`);
    if (ageHours === null) add('backup.never', 'warning', '還沒有成功的備份。請確認備份服務有啟動。');
    else if (ageHours > BACKUP_STALE_HOURS) add('backup.stale', 'critical', `最近一次成功備份是 ${ageHours} 小時前。`);
    if (search.rows[0]!.failed > 0) add('search.failed', 'warning', `有 ${search.rows[0]!.failed} 份教材處理失敗，AI 教練引用不到這些內容。`);
    if (expiryDays !== null && expiryDays <= 30) add('license.expiry', expiryDays <= 7 ? 'critical' : 'warning', `授權將在 ${expiryDays} 天後到期。`);
    if (maintenanceDays !== null && maintenanceDays <= 30) add('license.maintenance', maintenanceDays <= 7 ? 'warning' : 'info', `維護期將在 ${maintenanceDays} 天後結束。`);
    if (fallbackRatio !== null && fallbackRatio > FALLBACK_WARN) add('ai.fallback', 'warning', `今天有 ${Math.round(fallbackRatio * 100)}% 的 AI 教練回答落到安全替代訊息。`);
    if (tokensToday >= this.env.AI_DAILY_TOKEN_BUDGET_DEFAULT) add('ai.quota', 'warning', '今天的 AI 用量已達每日上限，教練會顯示「休息中」。');
    if (licence.state !== 'active') add('license.state', 'critical', '授權目前不是啟用狀態，設定類功能受限。');

    return {
      generatedAt: new Date().toISOString(),
      alerts,
      jobs: {
        pending: queue.pending,
        running: queue.running,
        oldestPendingSeconds: queue.oldest || null,
        deadLetters: jobs.deadLetters.total,
        staleLocks: jobs.staleLocks,
      },
      search: { configured: !!this.env.ELASTICSEARCH_URL, pendingDocuments: search.rows[0]!.pending, failedDocuments: search.rows[0]!.failed },
      ai: { requestsToday: a.requests, tokensToday, dailyBudget: this.env.AI_DAILY_TOKEN_BUDGET_DEFAULT, errorsToday: a.errors, fallbackRatio },
      storage: { databaseBytes: Number(s.database_bytes), documentBytes: Number(s.document_bytes), mediaBytes: Number(s.media_bytes) },
      license: {
        state: licence.state,
        daysToExpiry: expiryDays,
        daysToMaintenanceEnd: maintenanceDays,
        activeLearners: learners,
        maxActiveLearners: licence.maxActiveLearners ?? null,
      },
      backup: {
        lastSucceededAt: b.last_succeeded?.toISOString() ?? null,
        lastStatus: b.last_status,
        lastError: b.last_error,
        ageHours,
      },
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { LicenseType, LimitName } from '@iac/contracts';
import { computeCapabilities, type LicenseEvaluation } from '@iac/domain';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { logger } from '../../../common/logger.js';
import { ENV, type Env } from '../../../config/env.js';
import type { LicenseEvaluator } from '../license.contracts.js';
import { computeFingerprint } from '../infrastructure/fingerprint.js';

const CACHE_TTL_MS = 60_000;
const ROLLBACK_TOLERANCE_MS = 5 * 60_000;
const LAST_SEEN_INTERVAL_MS = 3_600_000;

/**
 * LicenseEvaluator 實作：讀 DB → 交給純函式 computeCapabilities 判定。
 * licenses 表只會由 LicenseActivationService 在驗簽通過後寫入。
 */
@Injectable()
export class LicenseService implements LicenseEvaluator {
  private cache: { value: LicenseEvaluation; at: number } | null = null;
  private readonly fingerprint: string;

  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.fingerprint = computeFingerprint(env.LICENSE_FINGERPRINT_OVERRIDE).value;
  }

  async evaluate(): Promise<LicenseEvaluation> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.value;

    const r = await this.db.query<{
      activation_id: string;
      license_type: LicenseType;
      expires_at: Date | null;
      maintenance_until: Date | null;
      features: Record<string, unknown>;
      limits: { max_organizations?: number; max_active_learners?: number };
      fingerprint: string;
      status: 'active' | 'revoked';
      last_seen_at: Date;
    }>(
      `SELECT a.id AS activation_id, l.license_type, l.expires_at, l.maintenance_until, l.features, l.limits,
              a.fingerprint, a.status, a.last_seen_at
         FROM license_activations a
         JOIN licenses l ON l.id = a.license_id
        WHERE a.status = 'active'
        ORDER BY a.activated_at DESC
        LIMIT 1`,
    );
    const row = r.rows[0];
    if (row) await this.touchActivation(row.activation_id, row.last_seen_at, now);

    const value = computeCapabilities(
      row
        ? {
            licenseType: row.license_type,
            expiresAt: row.expires_at,
            maintenanceUntil: row.maintenance_until,
            features: row.features,
            limits: row.limits,
          }
        : null,
      row ? { status: row.status, fingerprint: row.fingerprint } : null,
      new Date(now),
      {
        currentFingerprint: this.fingerprint,
        graceDays: this.env.LICENSE_GRACE_DAYS,
        graceAllowsConfig: false,
        graceAllowsAuthoring: false,
      },
    );

    this.cache = { value, at: now };
    return value;
  }

  async usage(limit: LimitName): Promise<number> {
    const sql =
      limit === 'maxOrganizations'
        ? `SELECT count(*)::int AS n FROM organizations WHERE status = 'active'`
        : // SD §8.4.2 的計數定義：active / suspended / reopened 的 distinct 學員，跨組織合計
          `SELECT count(DISTINCT user_id)::int AS n FROM enrollments WHERE status IN ('active','suspended','reopened')`;
    const r = await this.db.query<{ n: number }>(sql);
    return r.rows[0]?.n ?? 0;
  }

  /** 啟用新授權後呼叫，讓變更立即生效 */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * 時鐘回撥偵測（ARCH §18.5）：以應用程式時鐘記錄 last_seen_at（每小時一次）；
   * 若目前時間比 last_seen_at 早超過容許值，標記 clock_rollback_detected。
   * 只做紀錄與告警，不改變授權判定——這是 tamper detection，不是絕對防護。
   */
  private async touchActivation(activationId: string, lastSeen: Date, now: number): Promise<void> {
    try {
      if (now < lastSeen.getTime() - ROLLBACK_TOLERANCE_MS) {
        await this.db.query(`UPDATE license_activations SET clock_rollback_detected = true WHERE id = $1`, [activationId]);
        logger.warn({ activation_id: activationId, last_seen_at: lastSeen.toISOString() }, 'license clock rollback detected');
      } else if (now - lastSeen.getTime() > LAST_SEEN_INTERVAL_MS) {
        await this.db.query(`UPDATE license_activations SET last_seen_at = $2 WHERE id = $1`, [activationId, new Date(now)]);
      }
    } catch (err) {
      logger.warn({ err }, 'license last_seen update failed');
    }
  }
}

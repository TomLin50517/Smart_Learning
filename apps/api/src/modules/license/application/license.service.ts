import { Inject, Injectable } from '@nestjs/common';
import type { LicenseType, LimitName } from '@iac/contracts';
import { computeCapabilities, type LicenseEvaluation } from '@iac/domain';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { ENV, type Env } from '../../../config/env.js';
import type { LicenseEvaluator } from '../license.contracts.js';
import { computeFingerprint } from '../infrastructure/fingerprint.js';

const CACHE_TTL_MS = 60_000;

/**
 * LicenseEvaluator 實作：讀 DB → 交給純函式 computeCapabilities 判定。
 *
 * 注意：此處信任 licenses 表內容；簽章驗證發生在啟用流程（SEQ-08/09，後續實作），
 * 只有驗簽通過的 license 才會被寫入。
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
      license_type: LicenseType;
      expires_at: Date | null;
      maintenance_until: Date | null;
      features: Record<string, unknown>;
      limits: { max_organizations?: number; max_active_learners?: number };
      fingerprint: string;
      status: 'active' | 'revoked';
    }>(
      `SELECT l.license_type, l.expires_at, l.maintenance_until, l.features, l.limits,
              a.fingerprint, a.status
         FROM license_activations a
         JOIN licenses l ON l.id = a.license_id
        WHERE a.status = 'active'
        ORDER BY a.activated_at DESC
        LIMIT 1`,
    );
    const row = r.rows[0];

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
}

import type { KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PRODUCT_VERSION, type LicenseCapabilities, type LicenseChallenge, type LicenseInfo, type LicenseType } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { logger } from '../../../common/logger.js';
import { newToken } from '../../../common/tokens.js';
import { ENV, type Env } from '../../../config/env.js';
import { ACTIVATION_CLIENT, type ActivationClient } from '../infrastructure/activation-client.js';
import { computeFingerprint, type Fingerprint } from '../infrastructure/fingerprint.js';
import { loadLicensePublicKey, verifyLicenseToken } from '../infrastructure/license-token.js';
import { VENDOR_LICENSE_PUBLIC_KEY_PEM } from '../infrastructure/vendor-public-key.js';
import { LicenseService } from './license.service.js';

export type ActivationInput = { licenseFile: string } | { activationCode: string };

export interface ActivationResult {
  capabilities: LicenseCapabilities;
  licenseRowId: string;
  licenseId: string;
  licenseType: LicenseType;
  mode: 'online' | 'offline';
}

/**
 * 授權啟用（SA SEQ-08 線上、SEQ-09 離線）。
 *
 * 安裝前必須全部成立：
 *  1. 簽章由內建供應方 public key 驗證通過（只接受 EdDSA）
 *  2. hardware_binding 等於本機 fingerprint
 *  3. 帶 nonce 者：對應 challenge 存在、未使用、未過期、fingerprint 相符（一次性）
 *  4. 同一 license_id 不接受比已安裝版本更早簽發者（防止重裝舊授權）
 */
@Injectable()
export class LicenseActivationService {
  private readonly publicKey: KeyObject | null;
  private readonly fingerprint: Fingerprint;

  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly license: LicenseService,
    @Inject(ACTIVATION_CLIENT) private readonly client: ActivationClient,
  ) {
    const pem = env.LICENSE_PUBLIC_KEY_OVERRIDE || VENDOR_LICENSE_PUBLIC_KEY_PEM;
    this.publicKey = pem ? loadLicensePublicKey(pem) : null;
    if (!this.publicKey) {
      const log = env.NODE_ENV === 'production' ? logger.error.bind(logger) : logger.warn.bind(logger);
      log('vendor license public key is not configured — every license activation will be rejected');
    }
    this.fingerprint = computeFingerprint(env.LICENSE_FINGERPRINT_OVERRIDE);
  }

  async createChallenge(): Promise<LicenseChallenge & { id: string }> {
    const nonce = newToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.env.LICENSE_CHALLENGE_TTL_HOURS * 3_600_000);
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO license_challenges (nonce, fingerprint, product_version, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [nonce, this.fingerprint.value, PRODUCT_VERSION, expiresAt],
    );
    const blob = Buffer.from(
      JSON.stringify({
        v: 1,
        nonce,
        fingerprint: this.fingerprint.value,
        product_version: PRODUCT_VERSION,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      }),
    ).toString('base64url');

    return {
      id: r.rows[0]!.id,
      challenge: blob,
      fingerprint: this.fingerprint.value,
      weakFingerprint: this.fingerprint.weak,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async activate(input: ActivationInput): Promise<ActivationResult> {
    const mode = 'licenseFile' in input ? 'offline' : 'online';
    const token =
      'licenseFile' in input
        ? input.licenseFile
        : await this.client.activate({
            activationCode: input.activationCode,
            fingerprint: this.fingerprint.value,
            productVersion: PRODUCT_VERSION,
          });

    if (!this.publicKey) throw new DomainError('LICENSE_SIGNATURE_INVALID', 'Vendor license public key is not configured');
    const p = verifyLicenseToken(token, this.publicKey, new Date());
    if (p.hardware_binding !== this.fingerprint.value) throw new DomainError('LICENSE_HARDWARE_MISMATCH');

    const client = await this.db.connect();
    let licenseRowId: string;
    try {
      await client.query('BEGIN');

      if (p.nonce) {
        const c = await client.query(
          `UPDATE license_challenges SET used_at = now()
            WHERE nonce = $1 AND used_at IS NULL AND expires_at > now() AND fingerprint = $2
            RETURNING id`,
          [p.nonce, this.fingerprint.value],
        );
        if (!c.rowCount) throw new DomainError('LICENSE_CHALLENGE_INVALID');
      }

      const existing = await client.query<{ issued_at: Date }>(`SELECT issued_at FROM licenses WHERE license_id = $1 FOR UPDATE`, [
        p.license_id,
      ]);
      const installed = existing.rows[0];
      if (installed && new Date(p.issued_at) < installed.issued_at) {
        throw new DomainError('LICENSE_SIGNATURE_INVALID', 'License rejected: older than the installed license');
      }

      const lic = await client.query<{ id: string }>(
        `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, expires_at, maintenance_until,
                               hardware_binding, features, limits, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (license_id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id, edition = EXCLUDED.edition, license_type = EXCLUDED.license_type,
           issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at, maintenance_until = EXCLUDED.maintenance_until,
           hardware_binding = EXCLUDED.hardware_binding, features = EXCLUDED.features, limits = EXCLUDED.limits,
           raw_payload = EXCLUDED.raw_payload, imported_at = now()
         RETURNING id`,
        [
          p.license_id,
          p.customer_id,
          p.edition,
          p.license_type,
          p.issued_at,
          p.expires_at,
          p.maintenance_until,
          p.hardware_binding,
          p.features,
          p.limits,
          token,
        ],
      );
      licenseRowId = lic.rows[0]!.id;

      // 同一時間只有一筆有效啟用
      await client.query(
        `UPDATE license_activations SET status = 'revoked', revoked_at = now(), revoked_reason = 'replaced' WHERE status = 'active'`,
      );
      await client.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, $3)`, [
        licenseRowId,
        this.fingerprint.value,
        mode,
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    this.license.invalidate();
    const { reason: _internal, ...capabilities } = await this.license.evaluate();
    return { capabilities, licenseRowId, licenseId: p.license_id, licenseType: p.license_type, mode };
  }

  async info(): Promise<LicenseInfo> {
    // 先 evaluate（會更新 last_seen / 偵測時鐘回撥），再讀啟用資訊
    const { reason: _internal, ...capabilities } = await this.license.evaluate();
    const r = await this.db.query<{
      license_id: string;
      customer_id: string;
      edition: string;
      license_type: LicenseType;
      issued_at: Date;
      expires_at: Date | null;
      maintenance_until: Date | null;
      features: Record<string, unknown>;
      limits: { max_organizations?: number; max_active_learners?: number };
      mode: 'online' | 'offline';
      activated_at: Date;
      last_seen_at: Date;
      clock_rollback_detected: boolean;
    }>(
      `SELECT l.license_id, l.customer_id, l.edition, l.license_type, l.issued_at, l.expires_at, l.maintenance_until,
              l.features, l.limits, a.mode, a.activated_at, a.last_seen_at, a.clock_rollback_detected
         FROM license_activations a JOIN licenses l ON l.id = a.license_id
        WHERE a.status = 'active'
        ORDER BY a.activated_at DESC LIMIT 1`,
    );
    const row = r.rows[0];
    return {
      license: row
        ? {
            licenseId: row.license_id,
            customerId: row.customer_id,
            edition: row.edition,
            licenseType: row.license_type,
            issuedAt: row.issued_at.toISOString(),
            expiresAt: row.expires_at?.toISOString() ?? null,
            maintenanceUntil: row.maintenance_until?.toISOString() ?? null,
            features: row.features,
            limits: row.limits,
          }
        : null,
      activation: row
        ? {
            mode: row.mode,
            activatedAt: row.activated_at.toISOString(),
            lastSeenAt: row.last_seen_at.toISOString(),
            clockRollbackDetected: row.clock_rollback_detected,
          }
        : null,
      fingerprint: { current: this.fingerprint.value, weak: this.fingerprint.weak },
      onlineActivationAvailable: Boolean(this.env.LICENSE_ACTIVATION_URL),
      capabilities,
    };
  }
}

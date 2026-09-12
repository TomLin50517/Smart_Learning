import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { RateLimiter, accountBucket } from '../../../common/rate-limit.js';
import { hashPassword, verifyPassword } from '../infrastructure/password-hasher.js';

export const SUPPORTED_LOCALES = ['zh-TW', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * 本人的帳號操作（SA UC-ORG-005、SD §8.12）：切換組織、編輯個人資料、變更密碼。
 * 皆為 @AuthOnly——每個帳號都能管理自己（見 SD §8.12 對 self.profile.* 的說明）。
 */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * 切換目前 session 的 active organization。
   * 只能切到自己有角色、且為啟用狀態的組織；其他情況一律 404（ADR-019，不透露組織是否存在）。
   */
  async switchOrganization(userId: string, sessionId: string, organizationId: string): Promise<void> {
    const ok = await this.db.query(
      `SELECT 1 FROM user_org_roles uor JOIN organizations o ON o.id = uor.organization_id
        WHERE uor.user_id = $1 AND o.id = $2 AND o.status = 'active' LIMIT 1`,
      [userId, organizationId],
    );
    if (!ok.rowCount) throw new DomainError('NOT_FOUND');
    await this.db.query(`UPDATE user_sessions SET active_organization_id = $2 WHERE id = $1`, [sessionId, organizationId]);
  }

  /** 回傳新值與只含實際變更欄位的 before／after（稽核） */
  async updateProfile(userId: string, patch: { displayName?: string | undefined; locale?: SupportedLocale | undefined }) {
    const r = await this.db.query<{ display_name: string; locale: string }>(`SELECT display_name, locale FROM users WHERE id = $1`, [userId]);
    const cur = r.rows[0];
    if (!cur) throw new DomainError('UNAUTHENTICATED');
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    if (patch.displayName !== undefined && patch.displayName !== cur.display_name) {
      before['displayName'] = cur.display_name;
      after['displayName'] = patch.displayName;
    }
    if (patch.locale !== undefined && patch.locale !== cur.locale) {
      before['locale'] = cur.locale;
      after['locale'] = patch.locale;
    }
    if (Object.keys(after).length) {
      await this.db.query(`UPDATE users SET display_name = COALESCE($2, display_name), locale = COALESCE($3, locale) WHERE id = $1`, [
        userId,
        after['displayName'] ?? null,
        after['locale'] ?? null,
      ]);
    }
    return {
      profile: { displayName: after['displayName'] ?? cur.display_name, locale: after['locale'] ?? cur.locale },
      before,
      after,
    };
  }

  /**
   * 變更密碼：需驗證目前密碼、有流量限制。成功後：
   * - 撤銷本人其他所有 session（目前這個保留——使用者剛證明了知道密碼）
   * - 作廢尚未使用的重設／邀請連結，避免舊連結繞過新密碼
   */
  async changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string): Promise<{ revokedSessions: number }> {
    await this.limiter.enforce(accountBucket('pwchange', userId), 5, 900);

    const r = await this.db.query<{ password_hash: string | null }>(`SELECT password_hash FROM users WHERE id = $1 AND status = 'active'`, [userId]);
    const hash = r.rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(currentPassword, hash))) {
      throw new DomainError('VALIDATION_FAILED', 'Current password is incorrect', [{ field: 'currentPassword', issue: 'incorrect' }]);
    }
    if (await verifyPassword(newPassword, hash)) {
      throw new DomainError('VALIDATION_FAILED', 'New password must differ', [{ field: 'newPassword', issue: 'same_as_current' }]);
    }
    const newHash = await hashPassword(newPassword); // 在交易外計算，縮短鎖定時間

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, newHash]);
      const revoked = await client.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [
        userId,
        sessionId,
      ]);
      await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await client.query('COMMIT');
      return { revokedSessions: revoked.rowCount ?? 0 };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

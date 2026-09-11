import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { AuditWriter } from '../../../common/audit-writer.js';
import type { AuthUser } from '../../../common/context.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { logger } from '../../../common/logger.js';
import { RateLimiter, accountBucket } from '../../../common/rate-limit.js';
import { hashToken, newToken } from '../../../common/tokens.js';
import { ENV, type Env } from '../../../config/env.js';
import { hashPassword, needsRehash, verifyPassword } from '../infrastructure/password-hasher.js';
import { ACCOUNT_MAILER, type AccountMailer } from '../../notification/notification.contracts.js';
import type { UserInvitations } from '../identity.contracts.js';
import { SessionService, type ClientMeta, type IssuedSession } from './session.service.js';

export interface RequestMeta extends ClientMeta {
  correlationId: string;
}

type FailureReason = 'unknown_account' | 'inactive' | 'locked' | 'no_password' | 'bad_password';

/**
 * 登入、登出、refresh、密碼重設（SD §8.1、THR-S-001）。
 *
 * 對外一律回同一句「帳號或密碼錯誤」：不透露帳號是否存在、是否停用、是否被鎖。
 * 失敗原因只寫進 audit（metadata.reason）供管理者追查。
 */
@Injectable()
export class AuthService implements OnModuleInit, UserInvitations {
  /** 帳號不存在時用來比對的假雜湊，讓回應時間無法區分帳號是否存在 */
  private dummyHash = '';

  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditWriter,
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await hashPassword(newToken());
  }

  async login(email: string, password: string, meta: RequestMeta): Promise<{ user: AuthUser; session: IssuedSession }> {
    await this.limiter.enforce(`login:ip:${meta.ip ?? 'unknown'}`, 20, 60);
    await this.limiter.enforce(accountBucket('login', email), 5, 60);

    const r = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      locale: string;
      password_hash: string | null;
      status: string;
      locked: boolean | null;
    }>(
      `SELECT id, email, display_name, locale, password_hash, status, locked_until > now() AS locked
         FROM users WHERE email = $1`,
      [email],
    );
    const u = r.rows[0];

    // 不論帳號是否存在、是否被鎖，都執行一次完整雜湊比對
    const passwordOk = await verifyPassword(password, u?.password_hash ?? this.dummyHash);

    const reason: FailureReason | null = !u
      ? 'unknown_account'
      : u.status !== 'active'
        ? 'inactive'
        : u.locked
          ? 'locked'
          : !u.password_hash
            ? 'no_password'
            : !passwordOk
              ? 'bad_password'
              : null;

    if (reason) {
      if (reason === 'bad_password') await this.recordFailure(u!.id);
      await this.audit.write({
        action: 'auth.login.failed',
        resourceType: 'user',
        resourceId: u?.id ?? null,
        actorUserId: u?.id ?? null,
        outcome: 'denied',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        correlationId: meta.correlationId,
        // 未知帳號不記錄嘗試的 email：不把攻擊者輸入或他人 email 寫進稽核
        metadata: { reason },
      });
      throw new DomainError('UNAUTHENTICATED', 'Invalid email or password');
    }

    const user = u!;
    await this.db.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
    if (needsRehash(user.password_hash!)) {
      await this.db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(password)]);
    }

    const session = await this.sessions.issue(user.id, meta);
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        locale: user.locale,
        activeOrganizationId: session.activeOrganizationId,
      },
      session,
    };
  }

  logout(sessionId: string): Promise<void> {
    return this.sessions.revoke(sessionId);
  }

  refresh(sessionId: string, meta: ClientMeta): Promise<IssuedSession> {
    return this.sessions.rotate(sessionId, meta);
  }

  /**
   * 一律回 202，實際工作在回應送出後才執行——
   * 回應內容與時間都不因帳號存在與否而不同（THR-S-001 帳號探測）。
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    await this.limiter.enforce(`pwreset:ip:${meta.ip ?? 'unknown'}`, 10, 3600);
    await this.limiter.enforce(accountBucket('pwreset', email), 3, 3600);

    setImmediate(() => {
      this.issueResetToken(email, meta).catch((err: unknown) =>
        logger.error({ err, correlation_id: meta.correlationId }, 'password reset issuance failed'),
      );
    });
  }

  /** 設定新密碼：token 一次性、撤銷該使用者所有 session、解除鎖定 */
  async confirmPasswordReset(token: string, newPassword: string, meta: RequestMeta): Promise<AuthUser> {
    await this.limiter.enforce(`pwreset-confirm:ip:${meta.ip ?? 'unknown'}`, 10, 3600);
    const newHash = await hashPassword(newPassword); // 在交易外計算，縮短鎖定時間

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query<{ user_id: string }>(
        `SELECT user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [hashToken(token)],
      );
      const userId = t.rows[0]?.user_id;
      if (!userId) throw new DomainError('PASSWORD_RESET_TOKEN_INVALID');

      const u = await client.query<{ id: string; email: string; display_name: string; locale: string }>(
        `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL
          WHERE id = $1 AND status = 'active'
          RETURNING id, email, display_name, locale`,
        [userId, newHash],
      );
      if (!u.rows[0]) throw new DomainError('PASSWORD_RESET_TOKEN_INVALID');

      await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await client.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await client.query('COMMIT');

      const row = u.rows[0];
      return { id: row.id, email: row.email, displayName: row.display_name, locale: row.locale, activeOrganizationId: null };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 組織邀請：新成員以一次性連結自行設定密碼（有效期 INVITATION_TTL_HOURS）。
   * 回傳信件是否已交給郵件伺服器。寄送失敗不拋錯：帳號與成員資格已建立，
   * 對方仍可在登入頁以「忘記密碼」取得設定連結（SD §8.10）。
   */
  async invite(userId: string, organizationName: string): Promise<boolean> {
    const r = await this.db.query<{ id: string; email: string; locale: string }>(
      `SELECT id, email, locale FROM users WHERE id = $1 AND status = 'active'`,
      [userId],
    );
    const user = r.rows[0];
    if (!user) return false;
    const ttl = Math.round(this.env.INVITATION_TTL_HOURS * 60);
    const token = await this.issueToken(user.id, 'invite', ttl, null);
    try {
      await this.mailer.sendInvitation({
        to: user.email,
        locale: user.locale,
        link: this.link('set-password', token),
        expiresInMinutes: ttl,
        organizationName,
      });
      return true;
    } catch {
      logger.warn({ user_id: user.id }, 'invitation email not delivered; the user can still use password reset');
      return false;
    }
  }

  private async issueResetToken(email: string, meta: RequestMeta): Promise<void> {
    const r = await this.db.query<{ id: string; email: string; locale: string }>(
      `SELECT id, email, locale FROM users WHERE email = $1 AND status = 'active'`,
      [email],
    );
    const user = r.rows[0];
    if (!user) return;
    const ttl = Math.round(this.env.PASSWORD_RESET_TTL_MINUTES);
    const token = await this.issueToken(user.id, 'reset', ttl, meta.ip ?? null);
    await this.mailer.sendPasswordReset({ to: user.email, locale: user.locale, link: this.link('password-reset', token), expiresInMinutes: ttl });
  }

  private link(path: 'password-reset' | 'set-password', token: string): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/${path}?token=${encodeURIComponent(token)}`;
  }

  /** 發出新連結時，同一使用者先前未使用的連結（重設或邀請）一律作廢 */
  private async issueToken(userId: string, purpose: 'reset' | 'invite', ttlMinutes: number, ip: string | null): Promise<string> {
    const token = newToken();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // 新連結發出後，舊的未使用連結立即作廢
      await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, purpose)
         VALUES ($1, $2, now() + make_interval(mins => $3::int), $4, $5)`,
        [userId, hashToken(token), ttlMinutes, ip, purpose],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return token;
  }

  /** 連續失敗達上限即鎖定並歸零計數（單一 UPDATE，CASE 皆以更新前的值判斷） */
  private async recordFailure(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET
         failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
         locked_until       = CASE WHEN failed_login_count + 1 >= $2
                                   THEN now() + make_interval(mins => $3::int) ELSE locked_until END
       WHERE id = $1`,
      [userId, this.env.LOGIN_MAX_FAILURES, Math.round(this.env.LOGIN_LOCK_MINUTES)],
    );
  }
}

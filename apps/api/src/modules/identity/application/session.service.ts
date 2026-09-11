import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import pg from 'pg';
import { csrfTokenFor } from '../../../common/csrf.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { hashToken, newToken } from '../../../common/tokens.js';
import { ENV, type Env } from '../../../config/env.js';

export interface IssuedSession {
  id: string;
  /** 原始 token：只出現在 Set-Cookie，不落地 */
  token: string;
  csrfToken: string;
  expiresAt: Date;
  activeOrganizationId: string | null;
}

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

type Queryable = pg.Pool | pg.PoolClient;

/**
 * Session 生命週期（SD §8.1）：發放、輪替、撤銷、cookie。
 * DB 只存 token 的 SHA-256；絕對到期不因 refresh 而延長，閒置逾時由 AuthGuard 判定。
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async issue(
    userId: string,
    meta: ClientMeta,
    opts: { expiresAt?: Date; activeOrganizationId?: string | null } = {},
    q: Queryable = this.db,
  ): Promise<IssuedSession> {
    const token = newToken();
    const expiresAt = opts.expiresAt ?? new Date(Date.now() + this.env.SESSION_TTL_HOURS * 3_600_000);
    const activeOrganizationId =
      opts.activeOrganizationId !== undefined ? opts.activeOrganizationId : await this.defaultOrganization(userId, q);

    const r = await q.query<{ id: string }>(
      `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, hashToken(token), activeOrganizationId, expiresAt, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 512)],
    );
    const id = r.rows[0]!.id;
    return { id, token, csrfToken: csrfTokenFor(id, this.env.SESSION_SECRET), expiresAt, activeOrganizationId };
  }

  /**
   * Refresh：以新 token 取代舊 session（新 session id → 新 CSRF token），
   * 沿用原本的絕對到期與 active organization。舊 session 立即撤銷。
   */
  async rotate(sessionId: string, meta: ClientMeta): Promise<IssuedSession> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{ user_id: string; active_organization_id: string | null; expires_at: Date }>(
        `SELECT user_id, active_organization_id, expires_at FROM user_sessions
          WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sessionId],
      );
      const old = r.rows[0];
      if (!old) throw new DomainError('UNAUTHENTICATED');

      const next = await this.issue(
        old.user_id,
        meta,
        { expiresAt: old.expires_at, activeOrganizationId: old.active_organization_id },
        client,
      );
      await client.query(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
      await client.query('COMMIT');
      return next;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.query(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  }

  setCookies(reply: FastifyReply, s: IssuedSession): void {
    const maxAge = Math.max(0, Math.floor((s.expiresAt.getTime() - Date.now()) / 1000));
    const base = { secure: this.env.COOKIE_SECURE, sameSite: 'lax' as const, path: '/', maxAge };
    // session：HttpOnly，JS 讀不到（THR-S-002）
    void reply.setCookie(this.env.SESSION_COOKIE_NAME, s.token, { ...base, httpOnly: true });
    // CSRF：非 HttpOnly，前端需讀取並放進 X-CSRF-Token header（double submit）
    void reply.setCookie(this.env.CSRF_COOKIE_NAME, s.csrfToken, { ...base, httpOnly: false });
  }

  clearCookies(reply: FastifyReply): void {
    void reply.clearCookie(this.env.SESSION_COOKIE_NAME, { path: '/' });
    void reply.clearCookie(this.env.CSRF_COOKIE_NAME, { path: '/' });
  }

  private async defaultOrganization(userId: string, q: Queryable): Promise<string | null> {
    const r = await q.query<{ id: string }>(
      `SELECT o.id FROM user_org_roles uor
         JOIN organizations o ON o.id = uor.organization_id
        WHERE uor.user_id = $1 AND o.status = 'active'
        ORDER BY o.name LIMIT 1`,
      [userId],
    );
    return r.rows[0]?.id ?? null;
  }
}

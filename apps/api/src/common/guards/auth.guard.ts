import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { ENV, type Env } from '../../config/env.js';
import { DB_API } from '../database.module.js';
import { Public } from '../decorators.js';
import { DomainError } from '../domain-error.js';
import { hashToken } from '../tokens.js';

/**
 * INV-8 第 1 步：認證（SD §8.1）。
 * - session token 只以 SHA-256 雜湊存於 DB
 * - 絕對到期（expires_at）與閒置逾時（last_seen_at）兩者皆須成立
 * - last_seen_at 最多每 60 秒更新一次，避免每個請求都寫 DB
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride(Public, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = req.cookies?.[this.env.SESSION_COOKIE_NAME];
    if (!token) throw new DomainError('UNAUTHENTICATED');

    const r = await this.db.query<{
      session_id: string;
      id: string;
      email: string;
      display_name: string;
      locale: string;
      active_organization_id: string | null;
      stale: boolean;
    }>(
      `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.locale, s.active_organization_id,
              s.last_seen_at < now() - interval '60 seconds' AS stale
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.session_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => $2::int)
          AND u.status = 'active'
          AND (u.locked_until IS NULL OR u.locked_until < now())`,
      [hashToken(token), Math.round(this.env.SESSION_IDLE_MINUTES)],
    );
    const row = r.rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED');

    if (row.stale) {
      await this.db.query(`UPDATE user_sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id]);
    }

    req.ctx.sessionId = row.session_id;
    req.ctx.user = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      locale: row.locale,
      activeOrganizationId: row.active_organization_id,
    };
    return true;
  }
}

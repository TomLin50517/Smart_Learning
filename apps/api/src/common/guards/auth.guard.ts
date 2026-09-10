import { createHash } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { ENV, type Env } from '../../config/env.js';
import { DB_API } from '../database.module.js';
import { Public } from '../decorators.js';
import { DomainError } from '../domain-error.js';

/**
 * INV-8 第 1 步：認證。
 * Session token 只以 SHA-256 雜湊存於 DB（SD §8.1）；cookie 原值不落地。
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

    const hash = createHash('sha256').update(token).digest('hex');
    const r = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      locale: string;
      active_organization_id: string | null;
    }>(
      `SELECT u.id, u.email, u.display_name, u.locale, s.active_organization_id
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.session_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.status = 'active'
          AND (u.locked_until IS NULL OR u.locked_until < now())`,
      [hash],
    );
    const row = r.rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED');

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

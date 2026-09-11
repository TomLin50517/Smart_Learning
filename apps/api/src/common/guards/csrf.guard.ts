import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ENV, type Env } from '../../config/env.js';
import { csrfMatches, csrfTokenFor } from '../csrf.js';
import { Public } from '../decorators.js';
import { DomainError } from '../domain-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 防護（SD §8.2、THR-S-003）：已登入狀態下的所有狀態變更請求，
 * X-CSRF-Token header 與 CSRF cookie 都必須等於 HMAC(SESSION_SECRET, session id)。
 *
 * 公開路由（登入、密碼重設）沒有 session 可綁定，不在此檢查；
 * 其跨站風險由 SameSite=Lax cookie 與流量限制處理。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride(Public, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(req.method)) return true;

    const sessionId = req.ctx.sessionId;
    if (!sessionId) throw new DomainError('UNAUTHENTICATED');

    const expected = csrfTokenFor(sessionId, this.env.SESSION_SECRET);
    const header = req.headers['x-csrf-token'];
    const cookie = req.cookies?.[this.env.CSRF_COOKIE_NAME];
    if (!csrfMatches(expected, typeof header === 'string' ? header : undefined, cookie)) {
      throw new DomainError('CSRF_TOKEN_INVALID');
    }
    return true;
  }
}

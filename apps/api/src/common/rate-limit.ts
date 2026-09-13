import { createHash } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { DB_API } from './database.module.js';
import { DomainError } from './domain-error.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

/**
 * 流量限制（SD §8.8、THR-S-001、THR-D-*）：PostgreSQL 固定時間窗計數，不引入 Redis（ADR-011）。
 *
 * 一般 API 的每 session 限額刻意不在此實作——每個請求一次 DB 寫入不划算，
 * 由 nginx limit_req 作第一層（infra/nginx/nginx.conf）。此處只保護高風險端點。
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  /** cost：此次計入的次數（例：一批學習事件以筆數計） */
  async hit(bucket: string, limit: number, windowSec: number, cost = 1): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const r = await this.db.query<{ hits: number; remaining: number }>(
      `INSERT INTO rate_limit_counters (bucket, window_start, hits)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::float8) * $2::float8), $3)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limit_counters.hits + $3
       RETURNING hits,
                 ceil(extract(epoch FROM (window_start + make_interval(secs => $2::float8) - now())))::int AS remaining`,
      [bucket, windowSec, cost],
    );
    // 偶爾清理過期時間窗，避免無限成長
    if (Math.random() < 0.01) {
      this.db
        .query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 day'`)
        .catch((err: unknown) => logger.warn({ err }, 'rate limit cleanup failed'));
    }
    const row = r.rows[0]!;
    return { allowed: row.hits <= limit, retryAfterSec: Math.max(1, row.remaining) };
  }

  /** 超過限額即拋出 429 RATE_LIMITED（附 Retry-After） */
  async enforce(bucket: string, limit: number, windowSec: number, cost = 1): Promise<void> {
    const r = await this.hit(bucket, limit, windowSec, cost);
    if (!r.allowed) {
      // endpoint_group 只取 bucket 前綴（login／pwreset…），不含 IP 或帳號雜湊，避免 label 基數爆炸
      metrics.rateLimitHits.inc({ endpoint_group: bucket.split(':')[0] ?? 'unknown' });
      throw new DomainError('RATE_LIMITED', undefined, undefined, { retryAfterSec: r.retryAfterSec });
    }
  }
}

/** 帳號類 bucket：先雜湊，不把 email 原文或攻擊者輸入存進計數表 */
export function accountBucket(prefix: string, identifier: string): string {
  return `${prefix}:acct:${createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
}

export interface RateLimitRule {
  name: string;
  /** ip：公開端點；user：已登入端點（RateLimitGuard 在 AuthGuard 之後執行） */
  by: 'ip' | 'user';
  limit: number;
  windowSec: number;
}

export const RateLimit = Reflector.createDecorator<RateLimitRule[]>();

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride(RateLimit, [ctx.getHandler(), ctx.getClass()]);
    if (!rules?.length) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    for (const rule of rules) {
      const subject = rule.by === 'ip' ? req.ip : req.ctx.user?.id;
      if (!subject) continue;
      await this.limiter.enforce(`${rule.name}:${rule.by}:${subject}`, rule.limit, rule.windowSec);
    }
    return true;
  }
}

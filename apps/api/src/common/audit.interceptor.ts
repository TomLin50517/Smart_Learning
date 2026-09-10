import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUDIT_MUST_SUCCEED } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { concatMap, type Observable } from 'rxjs';
import { DB_API } from './database.module.js';
import { Audit, type AuditSpec } from './decorators.js';
import { DomainError } from './domain-error.js';
import { logger } from './logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * INV-8 第 5 步：成功後寫入 audit_logs（SD §12.3）。
 *
 * 一般 action：audit 寫入失敗只記錯誤，不讓已完成的業務操作失敗。
 * AUDIT_MUST_SUCCEED（逐字稿讀取）：留痕是權限開放的前提，寫不進去就讓請求失敗（ADR-028）。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB_API) private readonly db: pg.Pool,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.getAllAndOverride(Audit, [ctx.getHandler(), ctx.getClass()]);
    if (!spec) return next.handle();

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    return next.handle().pipe(
      concatMap(async (result) => {
        await this.write(spec, req);
        return result;
      }),
    );
  }

  private async write(spec: AuditSpec, req: FastifyRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const rawId = params[spec.param ?? 'id'];
    try {
      await this.db.query(
        `INSERT INTO audit_logs
           (actor_user_id, action, resource_type, resource_id, organization_id, course_id,
            outcome, actor_ip, actor_user_agent, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'success', $7, $8, $9)`,
        [
          req.ctx.user?.id ?? null,
          spec.action,
          spec.resourceType,
          rawId && UUID.test(rawId) ? rawId : null,
          req.ctx.target?.organizationId ?? req.ctx.user?.activeOrganizationId ?? null,
          req.ctx.target?.courseId ?? null,
          req.ip ?? null,
          (req.headers['user-agent'] ?? '').slice(0, 512),
          req.ctx.correlationId,
        ],
      );
    } catch (err) {
      logger.error({ err, action: spec.action, correlation_id: req.ctx.correlationId }, 'audit write failed');
      if (AUDIT_MUST_SUCCEED.has(spec.action)) {
        throw new DomainError('INTERNAL_ERROR', 'Audit trail could not be recorded');
      }
    }
  }
}

import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUDIT_MUST_SUCCEED } from '@iac/contracts';
import type { FastifyRequest } from 'fastify';
import { concatMap, type Observable } from 'rxjs';
import { AuditWriter } from './audit-writer.js';
import { Audit, type AuditSpec } from './decorators.js';
import { DomainError } from './domain-error.js';
import { logger } from './logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * INV-8 第 5 步：成功後寫入 audit_logs（SD §12.3）。
 *
 * 一般 action：audit 寫入失敗只記錯誤，不讓已完成的業務操作失敗。
 * AUDIT_MUST_SUCCEED（逐字稿讀取）：留痕是權限開放的前提，寫不進去就讓請求失敗（ADR-028）。
 *
 * actor 取自 req.ctx.user——公開路由（如登入）可在 handler 內設定它，讓稽核記到正確的人。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditWriter,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.getAllAndOverride(Audit, [ctx.getHandler(), ctx.getClass()]);
    if (!spec) return next.handle();

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    return next.handle().pipe(
      concatMap(async (result) => {
        await this.record(spec, req);
        return result;
      }),
    );
  }

  private async record(spec: AuditSpec, req: FastifyRequest): Promise<void> {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const rawId = params[spec.param ?? 'id'];
    try {
      await this.audit.write({
        action: spec.action,
        resourceType: spec.resourceType,
        resourceId: req.ctx.audit?.resourceId ?? (rawId && UUID.test(rawId) ? rawId : null),
        actorUserId: req.ctx.user?.id ?? null,
        organizationId: req.ctx.target?.organizationId ?? req.ctx.user?.activeOrganizationId ?? null,
        courseId: req.ctx.target?.courseId ?? null,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        correlationId: req.ctx.correlationId,
        before: req.ctx.audit?.before,
        after: req.ctx.audit?.after,
        ...(req.ctx.audit?.metadata && { metadata: req.ctx.audit.metadata }),
      });
    } catch (err) {
      logger.error({ err, action: spec.action, correlation_id: req.ctx.correlationId }, 'audit write failed');
      if (AUDIT_MUST_SUCCEED.has(spec.action)) {
        throw new DomainError('INTERNAL_ERROR', 'Audit trail could not be recorded');
      }
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { AuditAction } from '@iac/contracts';
import pg from 'pg';
import { DB_API } from './database.module.js';

export interface AuditRecord {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  actorUserId?: string | null;
  organizationId?: string | null;
  courseId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  ip?: string | null;
  userAgent?: string | null;
  correlationId: string;
  /** SD §12.1：只放實際變更的欄位；絕不含密碼、token、金鑰 */
  before?: unknown;
  after?: unknown;
  /** SD §12.1：只放必要資訊；絕不含密碼、token、金鑰 */
  metadata?: Record<string, unknown>;
}

/**
 * audit_logs 的唯一寫入口（SD §12.3）。
 * AuditInterceptor 寫「成功」；service 需要記錄「失敗」（例如登入失敗）時直接呼叫。
 */
@Injectable()
export class AuditWriter {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async write(r: AuditRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs
         (actor_user_id, action, resource_type, resource_id, organization_id, course_id,
          outcome, actor_ip, actor_user_agent, correlation_id, metadata, before_state, after_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        r.actorUserId ?? null,
        r.action,
        r.resourceType,
        r.resourceId ?? null,
        r.organizationId ?? null,
        r.courseId ?? null,
        r.outcome ?? 'success',
        r.ip ?? null,
        (r.userAgent ?? '').slice(0, 512),
        r.correlationId,
        r.metadata ?? {},
        r.before === undefined ? null : JSON.stringify(r.before),
        r.after === undefined ? null : JSON.stringify(r.after),
      ],
    );
  }
}

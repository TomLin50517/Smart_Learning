import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_EXPORT_MAX_ROWS, type AuditLogDto, type AuditLogPage } from '@iac/contracts';
import pg from 'pg';
import { z } from 'zod';
import type { AuditVisibility } from '../../../common/authz.js';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { toCsv } from '../../../common/csv.js';

export interface AuditFilter {
  /** 精確比對；以 ".*" 結尾表示前綴（例：org.*） */
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

interface Row {
  id: string;
  occurred_at: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  organization_id: string | null;
  course_id: string | null;
  outcome: 'success' | 'denied' | 'error';
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_ip: string | null;
  actor_user_agent: string | null;
  before_state: unknown;
  after_state: unknown;
  metadata: Record<string, unknown>;
  correlation_id: string | null;
  full_access: boolean;
}

// 以文字輸出 occurred_at：保留微秒精度（JS Date 只到毫秒，會讓 keyset 分頁漏列或重複）
const COLUMNS = `
  a.id, to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
  a.action, a.resource_type, a.resource_id, a.organization_id, a.course_id, a.outcome,
  a.actor_user_id, u.display_name AS actor_name, u.email AS actor_email,
  host(a.actor_ip) AS actor_ip, a.actor_user_agent, a.before_state, a.after_state, a.metadata, a.correlation_id`;

const Cursor = z.tuple([z.string().min(20).max(40), z.guid()]);

function encodeCursor(r: Row): string {
  return Buffer.from(JSON.stringify([r.occurred_at, r.id])).toString('base64url');
}

function decodeCursor(c: string): [string, string] {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')));
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Invalid cursor', [{ field: 'cursor', issue: 'invalid' }]);
  }
}

/** action 篩選 → [精確值, LIKE 樣式]（LIKE 特殊字元已由輸入驗證排除） */
function actionFilter(action: string | undefined): [string | null, string | null] {
  if (!action) return [null, null];
  return action.endsWith('.*') ? [null, `${action.slice(0, -1)}%`] : [action, null];
}

function toDto(r: Row): AuditLogDto {
  const base = {
    id: r.id,
    occurredAt: r.occurred_at,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    organizationId: r.organization_id,
    courseId: r.course_id,
    outcome: r.outcome,
  };
  if (!r.full_access) {
    // 只因「與本人相關」而可見：看得到誰在何時做了什麼，但看不到他人的 IP、裝置與變更內容
    return { ...base, visibility: 'self', actor: r.actor_user_id ? { id: r.actor_user_id, displayName: r.actor_name } : null };
  }
  return {
    ...base,
    visibility: 'full',
    actor: r.actor_user_id ? { id: r.actor_user_id, displayName: r.actor_name, ...(r.actor_email && { email: r.actor_email }) } : null,
    ip: r.actor_ip,
    userAgent: r.actor_user_agent,
    before: r.before_state,
    after: r.after_state,
    metadata: r.metadata,
    correlationId: r.correlation_id,
  };
}

/**
 * 稽核查詢與匯出（SA UC-AUD-001/002、SD §12.4）。
 * 讀取本身不寫稽核（SD §12.2：唯一例外為 coach.transcript.read）；匯出會寫 audit.exported。
 */
@Injectable()
export class AuditQueryService {
  constructor(@Inject(DB_API) private readonly db: pg.Pool) {}

  async list(v: AuditVisibility, userId: string, f: AuditFilter & { cursor?: string | undefined; limit: number }): Promise<AuditLogPage> {
    const [exact, like] = actionFilter(f.action);
    const [cursorAt, cursorId] = f.cursor ? decodeCursor(f.cursor) : [null, null];
    const full = `($1::bool OR a.organization_id = ANY($2::uuid[]) OR a.course_id = ANY($3::uuid[]))`;
    const r = await this.db.query<Row>(
      `SELECT ${COLUMNS}, COALESCE(${full}, false) AS full_access
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE (COALESCE(${full}, false)
               OR ($4::uuid IS NOT NULL AND (a.actor_user_id = $4::uuid OR a.resource_id = $4::uuid
                                             OR a.metadata->>'learner_id' = $4::text)))
          AND ($5::text IS NULL OR a.action = $5::text)
          AND ($6::text IS NULL OR a.action LIKE $6::text)
          AND ($7::timestamptz IS NULL OR a.occurred_at >= $7::timestamptz)
          AND ($8::timestamptz IS NULL OR a.occurred_at < $8::timestamptz)
          AND ($9::timestamptz IS NULL OR (a.occurred_at, a.id) < ($9::timestamptz, $10::uuid))
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $11`,
      [v.all, v.organizations, v.courses, v.self ? userId : null, exact, like, f.from ?? null, f.to ?? null, cursorAt, cursorId, f.limit + 1],
    );
    const page = r.rows.slice(0, f.limit);
    return { data: page.map(toDto), meta: { next_cursor: r.rows.length > f.limit ? encodeCursor(page[page.length - 1]!) : null } };
  }

  /**
   * 同步 CSV 匯出（ADR-032）：scope 為 'all'（平台）或可匯出的組織清單。
   * 指定 organizationId 時必須在 scope 內，否則 404（ADR-019）。超過列數上限回 400，不做部分匯出。
   */
  async export(scope: 'all' | string[], f: Required<Pick<AuditFilter, 'from' | 'to'>> & AuditFilter & { organizationId?: string | undefined }) {
    let orgs: string[] | null = scope === 'all' ? null : scope;
    if (f.organizationId) {
      if (orgs && !orgs.includes(f.organizationId)) throw new DomainError('NOT_FOUND');
      orgs = [f.organizationId];
    }
    const [exact, like] = actionFilter(f.action);
    const where = `($1::uuid[] IS NULL OR a.organization_id = ANY($1::uuid[]))
          AND ($2::text IS NULL OR a.action = $2::text)
          AND ($3::text IS NULL OR a.action LIKE $3::text)
          AND a.occurred_at >= $4::timestamptz AND a.occurred_at < $5::timestamptz`;
    const params = [orgs, exact, like, f.from, f.to];

    const count = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs a WHERE ${where}`, params);
    const n = count.rows[0]?.n ?? 0;
    if (n > AUDIT_EXPORT_MAX_ROWS) {
      throw new DomainError('VALIDATION_FAILED', 'Too many rows for a synchronous export', [{ field: 'to', issue: 'too_many_rows' }]);
    }

    const r = await this.db.query<Row>(
      `SELECT ${COLUMNS}, true AS full_access
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${where}
        ORDER BY a.occurred_at, a.id
        LIMIT ${AUDIT_EXPORT_MAX_ROWS}`,
      params,
    );
    const header = [
      'occurred_at', 'action', 'outcome', 'actor_user_id', 'actor_email', 'resource_type', 'resource_id',
      'organization_id', 'course_id', 'actor_ip', 'correlation_id', 'metadata', 'before', 'after',
    ];
    const rows = r.rows.map((x) => [
      x.occurred_at, x.action, x.outcome, x.actor_user_id, x.actor_email, x.resource_type, x.resource_id,
      x.organization_id, x.course_id, x.actor_ip, x.correlation_id, x.metadata, x.before_state, x.after_state,
    ]);
    return { csv: toCsv(header, rows), rows: rows.length };
  }
}

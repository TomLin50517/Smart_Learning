/** GET /api/audit-logs 的單筆紀錄（SA UC-AUD-001、SD §12.4） */
export interface AuditLogDto {
  id: string;
  /** ISO 8601（UTC，微秒精度） */
  occurredAt: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  organizationId: string | null;
  courseId: string | null;
  outcome: 'success' | 'denied' | 'error';
  actor: { id: string; displayName: string | null; email?: string } | null;
  /**
   * full：依管理範圍（平台／組織／課程）可見，含完整欄位。
   * self：只因與本人相關而可見（audit.read_self）——已移除 IP、User-Agent、變更前後、metadata 與執行者 email。
   */
  visibility: 'full' | 'self';
  ip?: string | null;
  userAgent?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
}

export interface AuditLogPage {
  data: AuditLogDto[];
  meta: { next_cursor: string | null };
}

/** 同步 CSV 匯出的上限（ADR-032） */
export const AUDIT_EXPORT_MAX_DAYS = 366;
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

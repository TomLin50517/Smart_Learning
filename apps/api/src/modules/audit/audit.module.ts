import { Module } from '@nestjs/common';
import { AuditController } from './api/audit.controller.js';
import { AuditQueryService } from './application/audit-query.service.js';

/**
 * MOD-AUDIT：append-only audit 查詢與匯出（寫入由 AuditInterceptor／AuditWriter 負責）
 * 護欄：不記錄 password/token/API key（ARCH §23.4）
 *
 * 已實作：GET /api/audit-logs（四種可見範圍）、POST /api/audit-logs/export（同步 CSV，ADR-032）
 */
@Module({
  controllers: [AuditController],
  providers: [AuditQueryService],
})
export class AuditModule {}

import { Module } from '@nestjs/common';

/**
 * MOD-AUDIT：append-only audit 查詢與匯出（寫入由 AuditInterceptor 負責）
 * 護欄：不記錄 password/token/API key（ARCH §23.4）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class AuditModule {}

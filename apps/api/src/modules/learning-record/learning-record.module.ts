import { Module } from '@nestjs/common';

/**
 * MOD-RECORD：LearningEvent ingest、attempt、result、timeline、progress snapshot
 * 護欄：Event append-only；身分欄位由 server 覆寫（ADR-021）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class LearningRecordModule {}

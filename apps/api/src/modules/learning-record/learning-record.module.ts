import { Module } from '@nestjs/common';
import { CompletionModule } from '../completion/completion.module.js';
import { LearnerController } from './api/learner.controller.js';
import { LearningService } from './application/learning.service.js';

/**
 * MOD-RECORD：LearningEvent ingest、attempt、result、timeline、progress snapshot
 * 護欄：Event append-only；身分欄位由 server 覆寫（ADR-021）；結果 append-only（INV-6）
 *
 * 已實作（Phase 2-2a，SD §6.9）：課程大綱、活動 Runtime、建立作答、送出與伺服器評分、作答結果。
 * 學習事件、timeline 於 2-3。
 */
@Module({
  imports: [CompletionModule],
  controllers: [LearnerController],
  providers: [LearningService],
})
export class LearningRecordModule {}

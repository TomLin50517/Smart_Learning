import { Module } from '@nestjs/common';
import { CompletionModule } from '../completion/completion.module.js';
import { LearnerController } from './api/learner.controller.js';
import { StaffLearningController } from './api/staff-learning.controller.js';
import { LearningEventService } from './application/learning-events.service.js';
import { LearningService } from './application/learning.service.js';
import { LEARNING_EVENTS } from './learning-record.contracts.js';

/**
 * MOD-RECORD：LearningEvent ingest、attempt、result、timeline、progress snapshot
 * 護欄：Event append-only；身分欄位由 server 覆寫（ADR-021）；結果 append-only（INV-6）
 *
 * 已實作：Phase 2-2a（SD §6.9）課程大綱、活動 Runtime、建立作答、送出與伺服器評分、作答結果；
 * Phase 2-3a（SD §6.12）學員端事件接收、伺服器端事件（經 LEARNING_EVENTS 也供選課模組寫入）、timeline、課程人員檢視學員進度。
 */
@Module({
  imports: [CompletionModule],
  controllers: [LearnerController, StaffLearningController],
  providers: [LearningService, LearningEventService, { provide: LEARNING_EVENTS, useExisting: LearningEventService }],
  exports: [LEARNING_EVENTS],
})
export class LearningRecordModule {}

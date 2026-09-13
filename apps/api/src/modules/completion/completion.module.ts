import { Module } from '@nestjs/common';
import { CompletionController } from './api/completion.controller.js';
import { CompletionEngineService } from './application/completion-engine.service.js';
import { COMPLETION_ENGINE } from './completion.contracts.js';

/**
 * MOD-COMPLETE：Rule Set 評估、進度計算、觸發 course.completed
 * 護欄：不得呼叫 LLM（INV-4）；評估器須為 packages/domain 內的純函式
 *
 * 已實作（Phase 2-2a，SD §6.9）：完成判定引擎（經 COMPLETION_ENGINE 提供給學習模組）、教師檢視完成判定。
 * course.completed 事件、證書 job、通知於後續批次。
 */
@Module({
  controllers: [CompletionController],
  providers: [CompletionEngineService, { provide: COMPLETION_ENGINE, useExisting: CompletionEngineService }],
  exports: [COMPLETION_ENGINE],
})
export class CompletionModule {}

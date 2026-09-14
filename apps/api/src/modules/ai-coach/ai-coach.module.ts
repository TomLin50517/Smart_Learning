import { Module } from '@nestjs/common';
import { ENV, type Env } from '../../config/env.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { CoachInsightsController } from './api/coach-insights.controller.js';
import { CoachSettingsController } from './api/coach-settings.controller.js';
import { CoachInsightsService } from './application/coach-insights.service.js';
import { CoachTestController } from './api/coach-test.controller.js';
import { CoachController } from './api/coach.controller.js';
import { CoachSettingsService } from './application/coach-settings.service.js';
import { CoachService } from './application/coach.service.js';
import { LLM_PROVIDER } from './infrastructure/llm-provider.js';
import { createLlmProvider } from './infrastructure/provider-factory.js';

/**
 * MOD-COACH：Policy、Context Builder、Prompt Composer、Provider Adapter、ResponseValidator、Conversation
 * 護欄：不得寫 learning_results / enrollments.status / certificates（INV-3）。唯一允許注入 DB_COACH 的模組（ADR-026）；dependency-cruiser 規則 coach-must-not-write-assessment 強制
 *
 * 已實作（Phase 3-3，SD §6.19）：學員問答（SSE）、教師測試、引用原文、組織設定。
 * 提示詞組裝與回答驗證為純函式（packages/domain/src/coach）；檢索經 KNOWLEDGE_RETRIEVER。
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [CoachController, CoachTestController, CoachSettingsController, CoachInsightsController],
  providers: [CoachService, CoachSettingsService, CoachInsightsService,{ provide: LLM_PROVIDER, useFactory: (env: Env) => createLlmProvider(env), inject: [ENV] }],
})
export class AiCoachModule {}

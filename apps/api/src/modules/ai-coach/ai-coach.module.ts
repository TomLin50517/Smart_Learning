import { Module } from '@nestjs/common';
import { parseEncryptionKey, SecretBox } from '../../common/secret-box.js';
import { ENV, type Env } from '../../config/env.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { AiCredentialController } from './api/ai-credential.controller.js';
import { CoachInsightsController } from './api/coach-insights.controller.js';
import { CoachSettingsController } from './api/coach-settings.controller.js';
import { CoachTestController } from './api/coach-test.controller.js';
import { CoachController } from './api/coach.controller.js';
import { AI_SECRET_BOX, AiCredentialService } from './application/ai-credentials.service.js';
import { CoachInsightsService } from './application/coach-insights.service.js';
import { CoachSettingsService } from './application/coach-settings.service.js';
import { CoachService } from './application/coach.service.js';
import { LLM_PROVIDER } from './infrastructure/llm-provider.js';
import { createLlmProvider } from './infrastructure/provider-factory.js';
import { LlmProviderResolver } from './infrastructure/provider-resolver.js';

/**
 * MOD-COACH：Policy、Context Builder、Prompt Composer、Provider Adapter、ResponseValidator、Conversation
 * 護欄：不得寫 learning_results / enrollments.status / certificates（INV-3）。唯一允許注入 DB_COACH 的模組（ADR-026）；dependency-cruiser 規則 coach-must-not-write-assessment 強制
 *
 * 已實作：學員問答（SSE）、教師測試、引用原文、組織設定（§6.19–6.20）；結果觸發、匿名統計、逐字稿（§6.21）；
 * 組織 AI 金鑰與 LiteLLM gateway（§6.22）。提示詞組裝與回答驗證為純函式（packages/domain/src/coach）。
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [CoachController, CoachTestController, CoachSettingsController, CoachInsightsController, AiCredentialController],
  providers: [
    CoachService,
    CoachSettingsService,
    CoachInsightsService,
    AiCredentialService,
    LlmProviderResolver,
    { provide: LLM_PROVIDER, useFactory: (env: Env) => createLlmProvider(env), inject: [ENV] },
    { provide: AI_SECRET_BOX, useFactory: (env: Env) => new SecretBox(parseEncryptionKey(env.AI_KEY_ENCRYPTION_KEY)), inject: [ENV] },
  ],
})
export class AiCoachModule {}

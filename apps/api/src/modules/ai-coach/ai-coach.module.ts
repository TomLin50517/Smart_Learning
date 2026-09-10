import { Module } from '@nestjs/common';

/**
 * MOD-COACH：Policy、Context Builder、Prompt Composer、Provider Adapter、ResponseValidator、Conversation
 * 護欄：不得寫 learning_results / enrollments.status / certificates（INV-3）。唯一允許注入 DB_COACH 的模組（ADR-026）；dependency-cruiser 規則 coach-must-not-write-assessment 強制
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class AiCoachModule {}

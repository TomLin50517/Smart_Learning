import { Module } from '@nestjs/common';

/**
 * MOD-COMPLETE：Rule Set 評估、進度計算、觸發 course.completed
 * 護欄：不得呼叫 LLM（INV-4）；評估器須為 packages/domain 內的純函式
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class CompletionModule {}

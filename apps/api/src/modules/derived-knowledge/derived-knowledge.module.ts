import { Module } from '@nestjs/common';
import { FaqController } from './api/faq.controller.js';
import { FaqService } from './application/faq.service.js';

/**
 * MOD-DERIVED：匿名彙整、clustering、candidate 生成、教師編修/verify/reject
 * 護欄：未達匿名門檻不得輸出（ARCH §14.5）
 *
 * 已實作（SD §6.27）：老師撰寫的常見問答與常見錯誤（直接生效、版本保留、下架）、系統整理的線索
 * （作答結果的問題代碼、學員提問去識別化後分群，達匿名門檻才出現）、學員看得到的 FAQ。
 * AI 起草在 MOD-COACH（擁有 LLM 供應商與用量紀錄）。尚未實作：自動排程產生候選（SEQ-07 全自動）。
 */
@Module({
  controllers: [FaqController],
  providers: [FaqService],
})
export class DerivedKnowledgeModule {}

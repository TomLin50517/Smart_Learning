import { Module } from '@nestjs/common';

/**
 * MOD-DERIVED：匿名彙整、clustering、candidate 生成、教師編修/verify/reject
 * 護欄：未達匿名門檻不得輸出（ARCH §14.5）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class DerivedKnowledgeModule {}

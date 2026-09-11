import { Module } from '@nestjs/common';

/**
 * MOD-RUNTIME：Runtime payload、Adapter Registry、H5P Adapter、submit orchestration
 * 護欄：不得呼叫 LLM 產生 ActivityResult；成績只由 server evaluator 產生（ADR-024）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class InteractiveRuntimeModule {}

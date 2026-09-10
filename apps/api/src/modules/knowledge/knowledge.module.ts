import { Module } from '@nestjs/common';

/**
 * MOD-KNOW：SourceDocument/DocumentVersion、chunk manifest、Retriever、Source Viewer ACL
 * 護欄：Retriever 不接受 client raw query（INV-7）
 *
 * 骨架模組——controllers / providers 於對應 Phase 實作（SD §16）。
 */
@Module({})
export class KnowledgeModule {}

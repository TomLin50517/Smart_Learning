import { Module } from '@nestjs/common';
import { createObjectStorage, OBJECT_STORAGE } from '../../common/object-storage.js';
import { ENV, type Env } from '../../config/env.js';
import { KnowledgeController } from './api/knowledge.controller.js';
import { KnowledgeService } from './application/knowledge.service.js';

/**
 * MOD-KNOW：SourceDocument/DocumentVersion、chunk manifest、Retriever、Source Viewer ACL
 * 護欄：Retriever 不接受 client raw query（INV-7）
 *
 * 已實作（Phase 3-1，SD §6.17）：教材上傳（串流、檔頭判斷格式、quarantine）、新版、綁定課程版本、預覽、重試、刪除。
 * 解析與切段由 worker 的 document.parse 執行；索引與檢索於 3-2。
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, { provide: OBJECT_STORAGE, useFactory: (env: Env) => createObjectStorage(env), inject: [ENV] }],
  exports: [OBJECT_STORAGE],
})
export class KnowledgeModule {}

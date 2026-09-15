import { Module } from '@nestjs/common';
import { createSearchClient, SEARCH_CLIENT } from '../../common/elasticsearch.js';
import { createObjectStorage, OBJECT_STORAGE } from '../../common/object-storage.js';
import { ENV, type Env } from '../../config/env.js';
import { KnowledgeController } from './api/knowledge.controller.js';
import { SharedKnowledgeController } from './api/shared-knowledge.controller.js';
import { KnowledgeService } from './application/knowledge.service.js';
import { LexicalKnowledgeRetriever } from './application/retriever.js';
import { KNOWLEDGE_RETRIEVER } from './knowledge.contracts.js';

/**
 * MOD-KNOW：SourceDocument/DocumentVersion、chunk manifest、Retriever、Source Viewer ACL
 * 護欄：Retriever 不接受 client raw query（INV-7）
 *
 * 已實作：教材上傳、新版、綁定、預覽、重試、刪除（3-1，SD §6.17）；
 * 檢索器與課程人員測試搜尋（3-2，SD §6.18）；組織共用教材（SD §6.27）。解析、索引、綁定同步由 worker 執行。
 */
@Module({
  controllers: [KnowledgeController, SharedKnowledgeController],
  providers: [
    KnowledgeService,
    LexicalKnowledgeRetriever,
    { provide: KNOWLEDGE_RETRIEVER, useExisting: LexicalKnowledgeRetriever },
    { provide: OBJECT_STORAGE, useFactory: (env: Env) => createObjectStorage(env), inject: [ENV] },
    { provide: SEARCH_CLIENT, useFactory: (env: Env) => createSearchClient(env), inject: [ENV] },
  ],
  exports: [KNOWLEDGE_RETRIEVER, OBJECT_STORAGE],
})
export class KnowledgeModule {}

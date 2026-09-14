import type { RetrieveParams, RetrievedChunk, RetrieveScope } from '@iac/domain';

/**
 * MOD-KNOW 對其他模組公開的介面（AI 教練，Phase 3-3）。
 * 檢索的唯一入口（SD §4.4.1、INV-7）：沒有接受 query DSL 的方法；範圍由呼叫端在伺服器上決定，不來自 HTTP body。
 */
export interface KnowledgeRetriever {
  /** 已設定 Elasticsearch */
  readonly available: boolean;
  retrieve(params: RetrieveParams, scope: RetrieveScope): Promise<RetrievedChunk[]>;
}

export const KNOWLEDGE_RETRIEVER = Symbol('KNOWLEDGE_RETRIEVER');

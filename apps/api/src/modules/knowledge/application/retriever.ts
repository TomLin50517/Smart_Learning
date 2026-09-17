import { Inject, Injectable } from '@nestjs/common';
import {
  buildKnnQuery,
  buildRetrieveQuery,
  fuseRankings,
  KNOWLEDGE_CHUNKS_ALIAS,
  MAX_QUERY_CHARS,
  rankHits,
  type RetrieveParams,
  type RetrievedChunk,
  type RetrieveScope,
  type SearchHit,
} from '@iac/domain';
import { DomainError } from '../../../common/domain-error.js';
import { EMBEDDING_CLIENT, type EmbeddingClient } from '../../../common/embedding.js';
import { SEARCH_CLIENT, type SearchClient } from '../../../common/elasticsearch.js';
import { logger } from '../../../common/logger.js';
import type { KnowledgeRetriever } from '../knowledge.contracts.js';

const unavailable = () => new DomainError('SOURCE_TEMPORARILY_UNAVAILABLE', 'Search is temporarily unavailable');

/**
 * 混合檢索（SD §4.4、§6.31）：BM25（cjk_bigram）與向量 kNN 各查一次，再以 RRF 合併
 * ——ES 內建的 RRF 需要 Enterprise 授權（basic 回 403），因此合併在 fuseRankings。
 *
 * 兩邊的查詢都由 domain 的純函式產生，四個範圍 filter 必定存在且凍結（INV-T6）。
 * 未設定 embedding、或問題向量化失敗時，自動退回 lexical_only——
 * **embedding 服務掛掉不該讓學員完全問不到東西**。
 */
@Injectable()
export class HybridKnowledgeRetriever implements KnowledgeRetriever {
  constructor(
    @Inject(SEARCH_CLIENT) private readonly es: SearchClient,
    @Inject(EMBEDDING_CLIENT) private readonly embedding: EmbeddingClient,
  ) {}

  get available(): boolean {
    return this.es.configured;
  }

  async retrieve(params: RetrieveParams, scope: RetrieveScope): Promise<RetrievedChunk[]> {
    const lexical = buildRetrieveQuery(params, scope);
    if (!lexical) return [];

    const vector = await this.queryVector(params.queryText);
    const semantic = vector ? buildKnnQuery(vector, params, scope) : null;

    const [lexHits, semHits] = await Promise.all([this.search(lexical), semantic ? this.search(semantic) : Promise.resolve([])]);
    // 沒有語意結果時維持原本的加權排序，行為與加入語意檢索前一致
    return semantic ? fuseRankings([lexHits, semHits], params.topK) : rankHits(lexHits, params.topK);
  }

  /** 問題的向量；未啟用或失敗回 null（退回 lexical，不讓整個檢索失敗） */
  private async queryVector(queryText: string): Promise<number[] | null> {
    if (!this.embedding.enabled) return null;
    try {
      return await this.embedding.embedQuery(queryText.trim().slice(0, MAX_QUERY_CHARS));
    } catch (err) {
      logger.warn({ err }, 'query embedding failed; falling back to lexical search');
      return null;
    }
  }

  private async search(query: Readonly<Record<string, unknown>>): Promise<SearchHit[]> {
    let r;
    try {
      r = await this.es.request<{ hits?: { hits?: SearchHit[] } }>('POST', `/${KNOWLEDGE_CHUNKS_ALIAS}/_search`, query);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      logger.warn({ err }, 'search request failed');
      throw unavailable();
    }
    // 還沒有任何教材完成索引時 index 尚未建立
    if (r.status === 404) return [];
    if (r.status >= 300) {
      logger.warn({ status: r.status, body: JSON.stringify(r.body).slice(0, 300) }, 'search returned an error');
      throw unavailable();
    }
    return r.body.hits?.hits ?? [];
  }
}

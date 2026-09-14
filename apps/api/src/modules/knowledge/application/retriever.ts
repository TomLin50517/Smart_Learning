import { Inject, Injectable } from '@nestjs/common';
import { buildRetrieveQuery, KNOWLEDGE_CHUNKS_ALIAS, rankHits, type RetrieveParams, type RetrievedChunk, type RetrieveScope, type SearchHit } from '@iac/domain';
import { DomainError } from '../../../common/domain-error.js';
import { SEARCH_CLIENT, type SearchClient } from '../../../common/elasticsearch.js';
import { logger } from '../../../common/logger.js';
import type { KnowledgeRetriever } from '../knowledge.contracts.js';

const unavailable = () => new DomainError('SOURCE_TEMPORARILY_UNAVAILABLE', 'Search is temporarily unavailable');

/**
 * lexical_only 檢索器（SD §4.4、§4.6）：查詢由 buildRetrieveQuery 產生（四個範圍 filter 必定存在且凍結），
 * 結果依知識類型加權排序。尚未建立 index（還沒有任何教材完成索引）視為沒有結果。
 */
@Injectable()
export class LexicalKnowledgeRetriever implements KnowledgeRetriever {
  constructor(@Inject(SEARCH_CLIENT) private readonly es: SearchClient) {}

  get available(): boolean {
    return this.es.configured;
  }

  async retrieve(params: RetrieveParams, scope: RetrieveScope): Promise<RetrievedChunk[]> {
    const query = buildRetrieveQuery(params, scope);
    if (!query) return [];
    let r;
    try {
      r = await this.es.request<{ hits?: { hits?: SearchHit[] } }>('POST', `/${KNOWLEDGE_CHUNKS_ALIAS}/_search`, query);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      logger.warn({ err }, 'search request failed');
      throw unavailable();
    }
    if (r.status === 404) return [];
    if (r.status >= 300) {
      logger.warn({ status: r.status, body: JSON.stringify(r.body).slice(0, 300) }, 'search returned an error');
      throw unavailable();
    }
    return rankHits(r.body.hits?.hits ?? [], params.topK);
  }
}

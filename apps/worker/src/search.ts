import { chunkIndexBody, KNOWLEDGE_CHUNKS_ALIAS, KNOWLEDGE_CHUNKS_INDEX } from '@iac/domain';
import { RetryableError } from './retry-policy.js';

/**
 * worker 的 Elasticsearch REST client（與 apps/api/src/common/elasticsearch.ts 同介面；worker 不引用 api 原始碼）。
 * 另支援 NDJSON（_bulk）。
 */
export interface SearchResponse<T> {
  status: number;
  body: T;
}

export interface SearchClient {
  readonly configured: boolean;
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, opts?: { ndjson?: boolean }): Promise<SearchResponse<T>>;
}

export function createWorkerSearch(env: { ELASTICSEARCH_URL: string; ELASTICSEARCH_API_KEY: string; ELASTICSEARCH_USERNAME: string; ELASTICSEARCH_PASSWORD: string }): SearchClient {
  if (!env.ELASTICSEARCH_URL) {
    return { configured: false, request: () => Promise.reject(new Error('search is not configured (ELASTICSEARCH_URL)')) };
  }
  const auth = env.ELASTICSEARCH_API_KEY
    ? `ApiKey ${env.ELASTICSEARCH_API_KEY}`
    : env.ELASTICSEARCH_USERNAME
      ? `Basic ${Buffer.from(`${env.ELASTICSEARCH_USERNAME}:${env.ELASTICSEARCH_PASSWORD}`).toString('base64')}`
      : null;
  return {
    configured: true,
    async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, opts: { ndjson?: boolean } = {}) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (auth) headers['authorization'] = auth;
      if (body !== undefined) headers['content-type'] = opts.ndjson ? 'application/x-ndjson' : 'application/json';
      let res: Response;
      try {
        res = await fetch(new URL(path, env.ELASTICSEARCH_URL), {
          method,
          headers,
          ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        // 連不上或逾時：稍後重試
        throw new RetryableError(`elasticsearch unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed as T };
    },
  };
}

/**
 * 第一次使用時建立 index 與 alias（SD §4.1）；已存在就略過。
 * `embeddingDims` 給定時才建立向量欄位——**既有的 index 不會被改寫**，
 * 因為 dense_vector 的 dims 無法追加；從 lexical 換成語意檢索需要重建 index（見 SD §6.31）。
 */
export async function ensureChunkIndex(es: SearchClient, embeddingDims: number | null = null): Promise<void> {
  const alias = await es.request('GET', `/_alias/${KNOWLEDGE_CHUNKS_ALIAS}`);
  if (alias.status === 200) {
    if (embeddingDims !== null) await assertVectorField(es);
    return;
  }
  const r = await es.request('PUT', `/${KNOWLEDGE_CHUNKS_INDEX}`, { ...chunkIndexBody(embeddingDims), aliases: { [KNOWLEDGE_CHUNKS_ALIAS]: { is_write_index: true } } });
  if (r.status < 300 || JSON.stringify(r.body).includes('resource_already_exists_exception')) return;
  throw new RetryableError(`create index failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
}

/** 錯誤訊息只取前段，避免把整份回應寫進 log */
export function describeFailure(r: SearchResponse<unknown>): string {
  return `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
}

interface MappingResponse {
  [index: string]: { mappings?: { properties?: Record<string, unknown> } };
}

/**
 * 既有 index 是否含向量欄位。
 *
 * 升級情境：舊部署已經有 knowledge_chunks_v1 與 alias，`ensureChunkIndex` 不會再建立 index，
 * 於是向量欄位永遠不存在；而 mapping 是 dynamic:'strict'，寫入帶 embedding 的文件會被 ES 拒絕。
 * 與其讓每份教材都索引失敗而看不出原因，這裡直接給出可執行的指示（見 docs/ops/semantic-search-migration.md）。
 */
async function assertVectorField(es: SearchClient): Promise<void> {
  const r = await es.request<MappingResponse>('GET', `/${KNOWLEDGE_CHUNKS_ALIAS}/_mapping`);
  if (r.status >= 300) throw new RetryableError(`could not read index mapping: ${describeFailure(r)}`);
  const hasVector = Object.values(r.body ?? {}).some((i) => i.mappings?.properties?.['embedding']);
  if (!hasVector) {
    throw new RetryableError(
      `索引 ${KNOWLEDGE_CHUNKS_ALIAS} 沒有 embedding 欄位，無法寫入向量。` +
        '啟用語意檢索需要重建索引，步驟見 docs/ops/semantic-search-migration.md；' +
        '若要維持關鍵字檢索，把 EMBEDDING_BASE_URL 留空即可。',
    );
  }
}

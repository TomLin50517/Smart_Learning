import { KNOWLEDGE_CHUNKS_ALIAS, KNOWLEDGE_CHUNKS_INDEX, KNOWLEDGE_CHUNKS_INDEX_BODY } from '@iac/domain';
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

/** 第一次使用時建立 index 與 alias（SD §4.1）；已存在就略過 */
export async function ensureChunkIndex(es: SearchClient): Promise<void> {
  const alias = await es.request('GET', `/_alias/${KNOWLEDGE_CHUNKS_ALIAS}`);
  if (alias.status === 200) return;
  const r = await es.request('PUT', `/${KNOWLEDGE_CHUNKS_INDEX}`, { ...KNOWLEDGE_CHUNKS_INDEX_BODY, aliases: { [KNOWLEDGE_CHUNKS_ALIAS]: { is_write_index: true } } });
  if (r.status < 300 || JSON.stringify(r.body).includes('resource_already_exists_exception')) return;
  throw new RetryableError(`create index failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
}

/** 錯誤訊息只取前段，避免把整份回應寫進 log */
export function describeFailure(r: SearchResponse<unknown>): string {
  return `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
}

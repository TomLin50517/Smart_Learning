import type { Env } from '../config/env.js';
import { DomainError } from './domain-error.js';

/**
 * Elasticsearch 以 REST 呼叫（fetch），不另裝官方 client（SD §4）。
 * worker 有同介面的實作（apps/worker/src/search.ts）。未設定 ELASTICSEARCH_URL 時 configured = false：
 * 檢索回 503，AI 教練顯示暫時無法使用，其餘功能不受影響。
 */
export interface SearchResponse<T> {
  status: number;
  body: T;
}

export interface SearchClient {
  readonly configured: boolean;
  request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<SearchResponse<T>>;
}

export const SEARCH_CLIENT = Symbol('SEARCH_CLIENT');

export function searchAuthHeader(env: { ELASTICSEARCH_API_KEY: string; ELASTICSEARCH_USERNAME: string; ELASTICSEARCH_PASSWORD: string }): string | null {
  if (env.ELASTICSEARCH_API_KEY) return `ApiKey ${env.ELASTICSEARCH_API_KEY}`;
  if (env.ELASTICSEARCH_USERNAME) return `Basic ${Buffer.from(`${env.ELASTICSEARCH_USERNAME}:${env.ELASTICSEARCH_PASSWORD}`).toString('base64')}`;
  return null;
}

export class HttpSearchClient implements SearchClient {
  readonly configured = true;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: string | null,
    private readonly timeoutMs = 10_000,
  ) {}

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<SearchResponse<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.auth) headers['authorization'] = this.auth;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  }
}

const unconfigured: SearchClient = {
  configured: false,
  request: () => Promise.reject(new DomainError('SOURCE_TEMPORARILY_UNAVAILABLE', 'Search is not configured (ELASTICSEARCH_URL)')),
};

export function createSearchClient(env: Env): SearchClient {
  return env.ELASTICSEARCH_URL ? new HttpSearchClient(env.ELASTICSEARCH_URL, searchAuthHeader(env)) : unconfigured;
}

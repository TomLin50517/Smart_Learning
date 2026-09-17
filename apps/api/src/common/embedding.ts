/**
 * Embedding client（SD §6.31）：檢索時把學員的問題轉成向量，與 worker 索引時用的是同一個
 * 模型與維度——不一致的向量比不出意義。worker 有同介面的實作（apps/worker/src/embedding.ts）。
 *
 * 平台層級金鑰（非組織的虛擬金鑰）：與索引側一致，見 ADR-034。
 * 未設定 → enabled 為 false，檢索維持 lexical_only。
 */
import { Inject, Injectable } from '@nestjs/common';
import { buildEmbeddingRequest, parseEmbeddingResponse, type EmbeddingResponseBody } from '@iac/domain';
import { ENV, type Env } from '../config/env.js';

export const EMBEDDING_CLIENT = Symbol('EMBEDDING_CLIENT');

export interface EmbeddingClient {
  readonly enabled: boolean;
  readonly dimensions: number;
  /** 單一查詢的向量；失敗時丟錯，由呼叫端決定是否退回 lexical */
  embedQuery(text: string): Promise<number[]>;
}

export const DISABLED_EMBEDDING: EmbeddingClient = {
  enabled: false,
  dimensions: 0,
  embedQuery: () => Promise.reject(new Error('embeddings are not configured (EMBEDDING_BASE_URL)')),
};

@Injectable()
export class HttpEmbeddingClient implements EmbeddingClient {
  private readonly url: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.url = `${env.EMBEDDING_BASE_URL.replace(/\/+$/, '')}/embeddings`;
  }

  get enabled(): boolean {
    return !!this.env.EMBEDDING_BASE_URL && !!this.env.EMBEDDING_API_KEY;
  }

  get dimensions(): number {
    return this.env.EMBEDDING_DIMENSIONS;
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.env.EMBEDDING_API_KEY}` },
      body: JSON.stringify(buildEmbeddingRequest(this.env.EMBEDDING_MODEL, [text])),
      signal: AbortSignal.timeout(this.env.EMBEDDING_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`embedding service returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const [vector] = parseEmbeddingResponse((await res.json()) as EmbeddingResponseBody, 1, this.env.EMBEDDING_DIMENSIONS);
    return vector!;
  }
}

export const createEmbeddingClient = (env: Env): EmbeddingClient => (env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY ? new HttpEmbeddingClient(env) : DISABLED_EMBEDDING);

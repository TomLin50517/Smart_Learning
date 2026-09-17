/**
 * Embedding client（SD §6.31）：OpenAI 相容的 `/embeddings`，以 fetch 呼叫，不另裝套件
 * （與 search.ts／storage.ts／mailer.ts 同風格）。api 端有同介面的實作。
 *
 * 用**平台層級**金鑰而非組織的虛擬金鑰：worker 依 ADR-034 讀不到 `organization_ai_credentials`
 * （DB 不變條件 T86）。建索引是系統行為，不是代表某組織對外發問；教練對話仍用組織金鑰。
 *
 * 未設定 → enabled 為 false，索引時不寫入向量，檢索自動退回 lexical_only（與加入語意檢索前相同）。
 */
import { buildEmbeddingRequest, parseEmbeddingResponse, type EmbeddingResponseBody } from '@iac/domain';
import { RetryableError } from './retry-policy.js';

export interface EmbeddingClient {
  readonly enabled: boolean;
  /** 向量維度；建立 index 時要用，與模型必須相符 */
  readonly dimensions: number;
  /** 回傳與 texts 一一對應的向量 */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface EmbeddingEnv {
  EMBEDDING_BASE_URL: string;
  EMBEDDING_API_KEY: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: number;
  EMBEDDING_TIMEOUT_MS: number;
}

export const DISABLED_EMBEDDING: EmbeddingClient = {
  enabled: false,
  dimensions: 0,
  embed: () => Promise.reject(new Error('embeddings are not configured (EMBEDDING_BASE_URL)')),
};

/** embedding 服務對單次的 input 數量與 token 總量都有上限，因此分批 */
export const EMBED_BATCH = 64;

/**
 * 分批取得向量；未啟用時回傳空陣列（呼叫端據此決定不寫入向量欄位）。
 * 教材索引與 FAQ 索引共用——兩邊都必須寫入向量，否則語意檢索會看不到其中一種知識來源。
 */
export async function embedAll(client: EmbeddingClient, texts: readonly string[]): Promise<number[][]> {
  if (!client.enabled || !texts.length) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) out.push(...(await client.embed(texts.slice(i, i + EMBED_BATCH))));
  return out;
}

export function createEmbeddingClient(env: EmbeddingEnv): EmbeddingClient {
  if (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_API_KEY) return DISABLED_EMBEDDING;
  const url = `${env.EMBEDDING_BASE_URL.replace(/\/+$/, '')}/embeddings`;
  return {
    enabled: true,
    dimensions: env.EMBEDDING_DIMENSIONS,
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (!texts.length) return [];
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.EMBEDDING_API_KEY}` },
          body: JSON.stringify(buildEmbeddingRequest(env.EMBEDDING_MODEL, texts)),
          signal: AbortSignal.timeout(env.EMBEDDING_TIMEOUT_MS),
        });
      } catch (e) {
        // 連不上或逾時：稍後重試（教材留在 indexing）
        throw new RetryableError(`embedding service unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new RetryableError(`embedding service returned ${res.status}: ${body}`);
      }
      // 對不齊、維度不符都會在這裡丟錯——寧可重試到 DLQ，也不要寫入錯位的向量
      return parseEmbeddingResponse((await res.json()) as EmbeddingResponseBody, texts.length, env.EMBEDDING_DIMENSIONS);
    },
  };
}

/**
 * Embedding 的請求與回應形狀（OpenAI 相容 `/embeddings`，SD §6.31）。
 * 純函式：HTTP 由 api 與 worker 各自的薄 client 處理（packages/domain 不做 I/O）。
 *
 * 用**平台層級**的金鑰，不是組織的虛擬金鑰——worker 依 ADR-034 讀不到
 * `organization_ai_credentials`（DB 不變條件 T86）。建索引是系統行為，不是代表某組織對外發問。
 */

/** 單段文字送出前的字元上限：embedding 模型多半是 8k tokens，中文約 1 字 1 token */
export const MAX_EMBEDDING_CHARS = 8000;

export interface EmbeddingRequestBody {
  model: string;
  input: string[];
}

/** 壓縮空白並截斷過長的文字；**不過濾空字串**——輸入與輸出必須一一對應 */
export function buildEmbeddingRequest(model: string, texts: readonly string[]): EmbeddingRequestBody {
  return { model, input: texts.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBEDDING_CHARS)) };
}

export interface EmbeddingResponseBody {
  data?: { embedding?: unknown; index?: number }[];
}

/**
 * 依 `index` 把向量放回原本的順序。
 *
 * 對不齊就丟錯，不做任何補救：少一筆、多一筆或維度不一致時若照樣寫入，
 * 每個 chunk 會配到別人的向量，檢索結果會莫名其妙而且**完全靜默**，事後幾乎查不出原因。
 */
export function parseEmbeddingResponse(body: EmbeddingResponseBody, expected: number, dimensions: number): number[][] {
  const data = body.data ?? [];
  if (data.length !== expected) throw new Error(`embedding count mismatch: expected ${expected}, got ${data.length}`);

  const out = new Array<number[] | undefined>(expected);
  data.forEach((d, i) => {
    const at = d.index ?? i;
    if (!Number.isInteger(at) || at < 0 || at >= expected) throw new Error(`embedding index out of range: ${String(d.index)}`);
    if (!Array.isArray(d.embedding) || d.embedding.length !== dimensions) {
      throw new Error(`embedding ${at} has ${Array.isArray(d.embedding) ? d.embedding.length : 'no'} dimensions, expected ${dimensions}`);
    }
    if (!d.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`embedding ${at} contains a non-finite value`);
    if (out[at]) throw new Error(`embedding index ${at} appeared twice`);
    out[at] = d.embedding as number[];
  });

  const missing = out.findIndex((v) => v === undefined);
  if (missing >= 0) throw new Error(`embedding ${missing} is missing from the response`);
  return out as number[][];
}

/**
 * LLM Provider Adapter（SD §10.5）。教練服務只依賴這個介面；供應商由 LlmProviderResolver 依環境與組織選定。
 * 共通行為：逾時、網路錯誤最多重試 1 次、錯誤只回分類（不把供應商的原始錯誤傳給前端）。
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: LlmMessage[];
  /** structured output 的 JSON Schema */
  responseSchema: Record<string, unknown>;
  maxTokens: number;
  correlationId: string;
  /** 用量歸屬標籤（例如 course:<id>、purpose:coach_answer）；不含學員資訊。只有 gateway 模式會送出 */
  tags?: string[];
}

export interface CompletionResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** 實際回答的模型（伺服器端改用備援模型時會不同） */
  model: string;
  latencyMs: number;
  finishReason: 'stop' | 'length' | 'refusal';
}

/**
 * unavailable：金鑰錯誤、無權限、模型不存在——設定問題
 * quota：限流或預算用完（LiteLLM 的金鑰預算）——暫時性，學員看到「AI 教練休息中」
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'timeout' | 'unavailable' | 'quota' | 'error',
    message: string,
    readonly latencyMs = 0,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** 測試連線的結果（不產生回答、不耗用 token） */
export interface ConnectionTest {
  ok: boolean;
  reason: 'ok' | 'unauthorized' | 'model_not_available' | 'unreachable' | 'quota' | 'error';
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** 已設定（有金鑰）；false 時教練不可用，系統其餘功能正常（NFR-AVAIL-002） */
  readonly available: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  testConnection?(): Promise<ConnectionTest>;
}

/** 平台層級的供應商（AI_PROVIDER=anthropic／openai…；litellm 模式下為 NONE，改由組織金鑰） */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** 未設定供應商（AI_PROVIDER=none 或缺金鑰） */
export const NONE_PROVIDER: LlmProvider = {
  name: 'none',
  model: 'none',
  available: false,
  complete: () => Promise.reject(new ProviderError('unavailable', 'AI provider is not configured')),
};

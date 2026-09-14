/**
 * LLM Provider Adapter（SD §10.5）。教練服務只依賴這個介面；供應商在 provider-factory.ts 依環境變數選定。
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

/** unavailable：金鑰錯誤、無權限、限流、模型不存在——學員看到「暫時無法使用」 */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'timeout' | 'unavailable' | 'error',
    message: string,
    readonly latencyMs = 0,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** 已設定（有金鑰）；false 時教練顯示暫時無法使用，系統其餘功能正常（NFR-AVAIL-002） */
  readonly available: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** 未設定供應商（AI_PROVIDER=none 或缺金鑰） */
export const NONE_PROVIDER: LlmProvider = {
  name: 'none',
  model: 'none',
  available: false,
  complete: () => Promise.reject(new ProviderError('unavailable', 'AI provider is not configured')),
};

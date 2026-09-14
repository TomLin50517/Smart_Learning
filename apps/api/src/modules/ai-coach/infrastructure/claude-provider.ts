import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type CompletionRequest, type CompletionResponse, type LlmProvider } from './llm-provider.js';

/**
 * Claude（Anthropic 官方 SDK）。回應格式以 structured output（output_config.format）限定為教練的 JSON Schema；
 * 思考深度以 effort 控制（Opus 5 預設開啟 adaptive thinking）。
 * 啟用伺服器端備援（fallbacks: "default"）：模型的安全分類器拒答時，由 Anthropic 依拒答類別改用建議的備援模型，
 * 仍在同一次呼叫內完成；整條鏈都拒答時 stop_reason 為 refusal，由教練改回安全替代回答。
 */
export class ClaudeProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly available = true;
  private readonly client: Anthropic;

  constructor(private readonly opts: { apiKey: string; baseURL?: string; model: string; effort: 'low' | 'medium' | 'high'; timeoutMs: number }) {
    // SDK 內建重試（連線錯誤、408/409/429/5xx）；教練只重試 1 次（SD §10.5）
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL && { baseURL: opts.baseURL }), timeout: opts.timeoutMs, maxRetries: 1 });
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    try {
      const res = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        output_config: { effort: this.opts.effort, format: { type: 'json_schema', schema: req.responseSchema } },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const u = res.usage;
      return {
        content: text,
        promptTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens,
        model: res.model,
        latencyMs: Date.now() - started,
        finishReason: res.stop_reason === 'refusal' ? 'refusal' : res.stop_reason === 'max_tokens' ? 'length' : 'stop',
      };
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError('timeout', 'request timed out', ms);
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) {
        throw new ProviderError('unavailable', `${e.status} ${e.name}`, ms);
      }
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError('unavailable', 'rate limited', ms);
      if (e instanceof Anthropic.APIError) throw new ProviderError('error', `${e.status ?? 'network'} ${e.name}`, ms);
      throw e;
    }
  }
}

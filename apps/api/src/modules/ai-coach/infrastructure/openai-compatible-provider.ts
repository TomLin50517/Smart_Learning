import { ProviderError, type CompletionRequest, type CompletionResponse, type LlmProvider } from './llm-provider.js';

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI 相容的 /chat/completions（Azure OpenAI、多數自架 gateway、客戶內部 LLM；SD §10.5）。以 fetch 呼叫，不另裝套件。
 * 回應格式以 response_format json_schema 要求；不支援的服務仍會由教練的解析與驗證把關。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly available = true;

  constructor(private readonly opts: { name: string; baseUrl: string; apiKey: string; model: string; timeoutMs: number }) {}

  get name(): string {
    return this.opts.name;
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) {
      headers['authorization'] = `Bearer ${this.opts.apiKey}`;
      if (this.opts.name === 'azure_openai') headers['api-key'] = this.opts.apiKey;
    }
    const body = JSON.stringify({
      model: this.opts.model,
      max_tokens: req.maxTokens,
      temperature: 0.2,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      response_format: { type: 'json_schema', json_schema: { name: 'coach_answer', schema: req.responseSchema } },
    });
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') throw new ProviderError('timeout', 'request timed out', Date.now() - started);
        // 網路錯誤重試一次
        if (attempt === 0) continue;
        throw new ProviderError('error', 'network error', Date.now() - started);
      }
      if ([401, 403, 404, 429].includes(res.status)) throw new ProviderError('unavailable', `http ${res.status}`, Date.now() - started);
      if (!res.ok) throw new ProviderError('error', `http ${res.status}`, Date.now() - started);
      const json = (await res.json()) as ChatCompletion;
      const choice = json.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        model: json.model ?? this.opts.model,
        latencyMs: Date.now() - started,
        finishReason: choice?.finish_reason === 'length' ? 'length' : choice?.finish_reason === 'content_filter' ? 'refusal' : 'stop',
      };
    }
  }
}

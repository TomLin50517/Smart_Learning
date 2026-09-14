import { ProviderError, type CompletionRequest, type CompletionResponse, type ConnectionTest, type LlmProvider } from './llm-provider.js';

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI 相容的 /chat/completions（LiteLLM gateway、Azure OpenAI、自架服務；SD §10.5、§6.22）。以 fetch 呼叫，不另裝套件。
 * 回應格式以 response_format json_schema 要求；不支援的服務仍由教練的解析與驗證把關。
 * LiteLLM：虛擬金鑰放在 Authorization: Bearer；用量標籤放在 metadata.tags（sendTags）；
 * 模型備援由 gateway 負責，這裡不送任何備援參數（LiteLLM 的 fallbacks 參數語意不同）。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly available = true;

  constructor(private readonly opts: { name: string; baseUrl: string; apiKey: string; model: string; timeoutMs: number; sendTags?: boolean }) {}

  get name(): string {
    return this.opts.name;
  }

  get model(): string {
    return this.opts.model;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) {
      h['authorization'] = `Bearer ${this.opts.apiKey}`;
      if (this.opts.name === 'azure_openai') h['api-key'] = this.opts.apiKey;
    }
    return h;
  }

  /** HTTP 狀態 → 錯誤分類；400 且內容提到預算（LiteLLM 的 budget_exceeded）也算額度用完 */
  private static classify(status: number, body: string): ProviderError['kind'] {
    if (status === 429 || (status === 400 && /budget/i.test(body))) return 'quota';
    if ([401, 403, 404].includes(status)) return 'unavailable';
    return 'error';
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = JSON.stringify({
      model: this.opts.model,
      max_tokens: req.maxTokens,
      temperature: 0.2,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      response_format: { type: 'json_schema', json_schema: { name: 'coach_answer', schema: req.responseSchema } },
      ...(this.opts.sendTags && req.tags?.length && { metadata: { tags: req.tags } }),
    });
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body, signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') throw new ProviderError('timeout', 'request timed out', Date.now() - started);
        // 網路錯誤重試一次
        if (attempt === 0) continue;
        throw new ProviderError('error', 'network error', Date.now() - started);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(OpenAiCompatibleProvider.classify(res.status, text), `http ${res.status}`, Date.now() - started);
      }
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

  /** GET /models：驗證金鑰與模型權限，不產生回答、不耗用 token */
  async testConnection(): Promise<ConnectionTest> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(this.url('/models'), { headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs, 15_000)) });
    } catch {
      return { ok: false, reason: 'unreachable', latencyMs: Date.now() - started };
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const kind = OpenAiCompatibleProvider.classify(res.status, await res.text().catch(() => ''));
      return { ok: false, reason: kind === 'unavailable' ? 'unauthorized' : kind === 'quota' ? 'quota' : 'error', latencyMs };
    }
    const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    const ids = (json?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    // 清單為空（有些 gateway 不列模型）時視為可用
    if (ids.length && !ids.includes(this.opts.model)) return { ok: false, reason: 'model_not_available', latencyMs };
    return { ok: true, reason: 'ok', latencyMs };
  }
}

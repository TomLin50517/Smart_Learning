import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env.js';
import { AiCredentialService } from '../application/ai-credentials.service.js';
import { LLM_PROVIDER, type LlmProvider } from './llm-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js';

export type ProviderStatus = { ok: true; provider: LlmProvider } | { ok: false; reason: 'provider_unavailable' | 'organization_key_missing' };

/**
 * 依組織選定供應商（SD §6.22）：
 * - AI_PROVIDER=litellm：LiteLLM gateway（OpenAI 相容），用該組織的虛擬金鑰；沒有金鑰 → organization_key_missing
 *   （不借用平台金鑰，帳才分得清楚）
 * - 其他：平台層級的供應商（LLM_PROVIDER）
 * 組織金鑰解密後依更新時間快取；金鑰更換後自動改用新的。
 */
@Injectable()
export class LlmProviderResolver {
  private readonly cache = new Map<string, { stamp: string; provider: OpenAiCompatibleProvider }>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LLM_PROVIDER) private readonly platform: LlmProvider,
    private readonly credentials: AiCredentialService,
  ) {}

  private get gatewayReady(): boolean {
    return !!this.env.AI_BASE_URL && !!this.env.AI_MODEL && this.credentials.encryptionReady;
  }

  /** 不解密，只判斷能不能用（畫面顯示用） */
  async status(organizationId: string): Promise<{ ok: boolean; reason: 'provider_unavailable' | 'organization_key_missing' | null }> {
    if (!this.credentials.perOrganization) return this.platform.available ? { ok: true, reason: null } : { ok: false, reason: 'provider_unavailable' };
    if (!this.gatewayReady) return { ok: false, reason: 'provider_unavailable' };
    return (await this.credentials.stamp(organizationId)) ? { ok: true, reason: null } : { ok: false, reason: 'organization_key_missing' };
  }

  async forOrganization(organizationId: string): Promise<ProviderStatus> {
    if (!this.credentials.perOrganization) return this.platform.available ? { ok: true, provider: this.platform } : { ok: false, reason: 'provider_unavailable' };
    if (!this.gatewayReady) return { ok: false, reason: 'provider_unavailable' };
    const stamp = await this.credentials.stamp(organizationId);
    if (!stamp) {
      this.cache.delete(organizationId);
      return { ok: false, reason: 'organization_key_missing' };
    }
    const hit = this.cache.get(organizationId);
    if (hit && hit.stamp === stamp) return { ok: true, provider: hit.provider };
    const secret = await this.credentials.secret(organizationId);
    // 解不開（主金鑰被換掉）視為平台設定問題
    if (!secret) return { ok: false, reason: 'provider_unavailable' };
    const provider = new OpenAiCompatibleProvider({
      name: 'litellm',
      baseUrl: this.env.AI_BASE_URL,
      apiKey: secret.key,
      model: this.env.AI_MODEL,
      timeoutMs: this.env.AI_TIMEOUT_MS,
      sendTags: true,
    });
    this.cache.set(organizationId, { stamp: secret.stamp, provider });
    return { ok: true, provider };
  }
}

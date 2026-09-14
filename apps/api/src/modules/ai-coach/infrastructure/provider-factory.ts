import { logger } from '../../../common/logger.js';
import type { Env } from '../../../config/env.js';
import { ClaudeProvider } from './claude-provider.js';
import { NONE_PROVIDER, type LlmProvider } from './llm-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

/**
 * 依環境變數選定供應商。缺少必要設定時退回 NONE（教練顯示暫時無法使用），並記一次警告——不讓 API 無法啟動。
 * 金鑰只從環境變數讀取，不寫入資料庫或設定端點（ADR-031）。
 */
export function createLlmProvider(env: Env): LlmProvider {
  switch (env.AI_PROVIDER) {
    case 'none':
    // litellm：沒有平台金鑰，每個組織用自己的虛擬金鑰（LlmProviderResolver）
    case 'litellm':
      return NONE_PROVIDER;
    case 'anthropic': {
      const apiKey = env.AI_API_KEY || env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        logger.warn('AI_PROVIDER=anthropic but no API key (AI_API_KEY or ANTHROPIC_API_KEY); the AI coach is unavailable');
        return NONE_PROVIDER;
      }
      return new ClaudeProvider({
        apiKey,
        ...(env.AI_BASE_URL && { baseURL: env.AI_BASE_URL }),
        model: env.AI_MODEL || DEFAULT_CLAUDE_MODEL,
        effort: env.AI_EFFORT,
        timeoutMs: env.AI_TIMEOUT_MS,
      });
    }
    default: {
      if (!env.AI_BASE_URL || !env.AI_MODEL) {
        logger.warn({ provider: env.AI_PROVIDER }, 'AI_BASE_URL and AI_MODEL are required for this AI provider; the AI coach is unavailable');
        return NONE_PROVIDER;
      }
      return new OpenAiCompatibleProvider({ name: env.AI_PROVIDER, baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL, timeoutMs: env.AI_TIMEOUT_MS });
    }
  }
}

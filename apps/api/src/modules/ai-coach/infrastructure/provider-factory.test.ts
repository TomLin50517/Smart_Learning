import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../config/env.js';
import { ClaudeProvider } from './claude-provider.js';
import { NONE_PROVIDER } from './llm-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js';
import { createLlmProvider, DEFAULT_CLAUDE_MODEL } from './provider-factory.js';

const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x@h/db', DATABASE_URL_COACH: 'postgres://x@h/db', SESSION_SECRET: 's'.repeat(40) };
const make = (extra: Record<string, string>) => createLlmProvider(loadEnv({ ...base, ...extra }));

describe('createLlmProvider — the coach is unavailable, never broken, when AI is not set up', () => {
  it('defaults to no provider (data leaving the premises must be a deliberate choice)', () => {
    expect(make({})).toBe(NONE_PROVIDER);
    expect(NONE_PROVIDER.available).toBe(false);
  });

  it('Claude needs a key; the model defaults to Claude Opus 5 and can be overridden', () => {
    expect(make({ AI_PROVIDER: 'anthropic' })).toBe(NONE_PROVIDER);
    const p = make({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key' });
    expect(p).toBeInstanceOf(ClaudeProvider);
    expect(p.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(make({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'claude-sonnet-5' }).model).toBe('claude-sonnet-5');
  });

  it('OpenAI-compatible services need a base URL and a model', () => {
    expect(make({ AI_PROVIDER: 'openai', AI_API_KEY: 'k' })).toBe(NONE_PROVIDER);
    const p = make({ AI_PROVIDER: 'internal', AI_BASE_URL: 'http://llm.local/v1', AI_MODEL: 'local-model' });
    expect(p).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(p.name).toBe('internal');
  });

  it('rejects an unknown provider name at startup', () => {
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'gpt' })).toThrow();
  });
});

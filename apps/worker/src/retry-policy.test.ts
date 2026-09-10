import { describe, expect, it } from 'vitest';
import { FatalError, RetryableError, backoffMs, onFailure } from './retry-policy.js';

const NOW = new Date('2026-09-10T00:00:00Z');
const noJitter = () => 0.5; // random 0.5 → jitter factor exactly 1.0

describe('backoffMs', () => {
  it('doubles from 30s', () => {
    expect(backoffMs(1, noJitter)).toBe(60_000);
    expect(backoffMs(2, noJitter)).toBe(120_000);
    expect(backoffMs(3, noJitter)).toBe(240_000);
  });

  it('caps at 1 hour', () => {
    expect(backoffMs(20, noJitter)).toBe(3_600_000);
  });

  it('jitter stays within ±20%', () => {
    expect(backoffMs(2, () => 0)).toBe(96_000);
    expect(backoffMs(2, () => 1)).toBe(144_000);
  });
});

describe('onFailure (SD §11.3)', () => {
  it('retryable error with attempts left → retry after backoff', () => {
    const out = onFailure(new RetryableError('smtp timeout'), { attempts: 1, maxAttempts: 5 }, NOW, noJitter);
    expect(out).toEqual({ kind: 'retry', runAfter: new Date(NOW.getTime() + 60_000) });
  });

  it('last attempt → dead letter', () => {
    const out = onFailure(new RetryableError('smtp timeout'), { attempts: 5, maxAttempts: 5 }, NOW);
    expect(out.kind).toBe('dead');
  });

  it('fatal error → dead letter immediately, even with attempts left', () => {
    const out = onFailure(new FatalError('bad payload'), { attempts: 1, maxAttempts: 5 }, NOW);
    expect(out).toEqual({ kind: 'dead', reason: 'FatalError: bad payload' });
  });

  it('unknown thrown values are treated as retryable', () => {
    expect(onFailure('boom', { attempts: 1, maxAttempts: 3 }, NOW, noJitter).kind).toBe('retry');
  });
});

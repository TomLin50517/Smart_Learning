/**
 * Job 失敗後的去向（SD §11.3）。純函式，時間與亂數由呼叫端注入，方便測試。
 */

/** 可重試：進入 backoff；用盡次數後進 DLQ */
export class RetryableError extends Error {
  override name = 'RetryableError';
}
/** 不可重試：直接進 DLQ（例如 payload 格式錯誤、找不到 handler） */
export class FatalError extends Error {
  override name = 'FatalError';
}

const BASE_MS = 30_000;
const CAP_MS = 3_600_000;

/** delay = min(2^attempts × 30s, 1h)，再加上 ±20% jitter，避免同批失敗的 job 同時重試 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const raw = Math.min(2 ** attempts * BASE_MS, CAP_MS);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(raw * jitter);
}

export type FailureOutcome = { kind: 'retry'; runAfter: Date } | { kind: 'dead'; reason: string };

export function onFailure(
  err: unknown,
  job: { attempts: number; maxAttempts: number },
  now: Date,
  random: () => number = Math.random,
): FailureOutcome {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof FatalError) return { kind: 'dead', reason };
  // attempts 已在 claim 時 +1，因此 attempts === maxAttempts 代表這是最後一次
  if (job.attempts >= job.maxAttempts) return { kind: 'dead', reason: `max attempts reached — ${reason}` };
  return { kind: 'retry', runAfter: new Date(now.getTime() + backoffMs(job.attempts, random)) };
}

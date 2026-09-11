import type { z } from 'zod';
import { DomainError } from './domain-error.js';

/**
 * 以 zod 驗證 request body / query。失敗回 400 VALIDATION_FAILED，
 * details 只含欄位路徑與錯誤類型，不回傳使用者輸入的原值（避免回顯密碼等敏感內容）。
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.map((i) => ({ field: i.path.map(String).join('.'), issue: i.code })),
    );
  }
  return r.data;
}

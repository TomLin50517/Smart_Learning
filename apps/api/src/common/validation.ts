import type { z } from 'zod';
import { DomainError } from './domain-error.js';

/**
 * 以 zod 驗證 request body / query。失敗回 400 VALIDATION_FAILED，
 * details 只含欄位路徑與錯誤類型，不回傳使用者輸入的原值（避免回顯密碼等敏感內容）。
 *
 * 自訂規則（refine / addIssue，code = 'custom'）以 message 作為 issue——
 * 因此 refine 的 message 一律寫成固定的代碼（例：range_too_large），不可內嵌輸入值。
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.flatMap((i) => {
        const at = i.path.map(String);
        // strictObject 的多餘欄位：zod 把鍵名放在 keys（path 為物件本身），逐一展開才看得出是哪個欄位
        if (i.code === 'unrecognized_keys') return i.keys.map((k) => ({ field: [...at, k].join('.'), issue: 'unrecognized_key' }));
        return [{ field: at.join('.'), issue: i.code === 'custom' ? i.message : i.code }];
      }),
    );
  }
  return r.data;
}

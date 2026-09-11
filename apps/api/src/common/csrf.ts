import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * CSRF token（SD §8.2：double-submit 且綁定 session）。
 *
 * token = HMAC-SHA256(SESSION_SECRET, session id)
 *  - 綁定 session：換 session（登入、refresh 輪替）token 就變，不能跨 session 重用
 *  - 不需儲存：由 session id 即可重算
 *  - 攻擊者無法偽造：不知道 SESSION_SECRET
 */
export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

/** 所有候選值都必須與預期值完全相同（常數時間比對） */
export function csrfMatches(expected: string, ...candidates: (string | undefined)[]): boolean {
  const e = Buffer.from(expected);
  return candidates.every(
    (c) => typeof c === 'string' && c.length === expected.length && timingSafeEqual(Buffer.from(c), e),
  );
}

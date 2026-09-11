import { createHash, randomBytes } from 'node:crypto';

/** 256-bit 隨機 token（session、密碼重設）；以 base64url 放進 cookie / URL */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** DB 只存 token 的 SHA-256；原值不落地（SD §8.1） */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

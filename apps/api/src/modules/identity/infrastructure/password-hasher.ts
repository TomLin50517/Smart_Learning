import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id 密碼雜湊（SD §8.1）。
 *
 * 使用 Node 24.7+ 內建的 crypto.argon2（已通過 RFC 9106 測試向量）。該 API 在 Node 中仍標示
 * experimental，因此輸出採標準 PHC 字串：日後若改用其他實作（如 @node-rs/argon2），
 * 既有雜湊可直接驗證，不需要使用者重設密碼。
 */
export interface Argon2Params {
  /** KiB */
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

/** SD §8.1（OWASP 建議起點）；調整後舊雜湊於下次成功登入時自動升級（needsRehash） */
export const PASSWORD_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

const SALT_BYTES = 16;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
/** 驗證時拒絕離譜參數，避免被竄改的雜湊字串拖垮伺服器 */
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 16;

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, memory: p.memory, passes: p.passes, parallelism: p.parallelism, tagLength: p.tagLength },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string, p: Argon2Params = PASSWORD_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, p);
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(tag)}`;
}

function parse(phc: string): { params: Argon2Params; salt: Buffer; hash: Buffer } | null {
  const m = PHC.exec(phc);
  if (!m) return null;
  const hash = Buffer.from(m[5]!, 'base64');
  return {
    params: { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: hash.length },
    salt: Buffer.from(m[4]!, 'base64'),
    hash,
  };
}

/** 格式錯誤或參數異常一律回 false，不拋錯 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const p = parse(phc);
  if (!p || p.hash.length < 16 || p.salt.length < 8) return false;
  if (p.params.memory > MAX_MEMORY_KIB || p.params.passes > MAX_PASSES) return false;
  const tag = await derive(password, p.salt, p.params);
  return tag.length === p.hash.length && timingSafeEqual(tag, p.hash);
}

export function needsRehash(phc: string, p: Argon2Params = PASSWORD_PARAMS): boolean {
  const x = parse(phc);
  if (!x) return true;
  return (
    x.params.memory !== p.memory ||
    x.params.passes !== p.passes ||
    x.params.parallelism !== p.parallelism ||
    x.params.tagLength !== p.tagLength
  );
}

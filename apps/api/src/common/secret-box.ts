import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 機密的加密存放（ADR-034）：AES-256-GCM，主金鑰只在環境變數。
 * AAD（附加驗證資料）綁定擁有者（例如組織 id）：密文被搬到別的列會解不開，被竄改也會解不開。
 */
export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export const SECRET_KEY_VERSION = 1;

/** 空字串 → null（未設定）；長度不對 → 丟錯（啟動時的 env 驗證已先擋下） */
export function parseEncryptionKey(b64: string): Buffer | null {
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (base64)');
  return key;
}

export class SecretBox {
  constructor(private readonly key: Buffer | null) {}

  get ready(): boolean {
    return this.key !== null;
  }

  seal(plaintext: string, aad: string): Sealed {
    if (!this.key) throw new Error('encryption key is not configured');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return { ciphertext, iv, authTag: c.getAuthTag() };
  }

  /** 金鑰不對、AAD 不符或被竄改 → 丟錯 */
  open(s: Sealed, aad: string): string {
    if (!this.key) throw new Error('encryption key is not configured');
    const d = createDecipheriv('aes-256-gcm', this.key, s.iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(s.authTag);
    return Buffer.concat([d.update(s.ciphertext), d.final()]).toString('utf8');
  }
}

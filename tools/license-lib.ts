/**
 * 【供應方專用】授權簽發共用函式。不隨產品交付（Dockerfile 不會複製）。
 * 產品端只做驗證：apps/api/src/modules/license/infrastructure/license-token.ts
 */
import { sign, type KeyObject } from 'node:crypto';

export interface ChallengeBlob {
  v: 1;
  nonce: string;
  fingerprint: string;
  product_version: string;
  issued_at: string;
  expires_at: string;
}

/** JWS compact：base64url(header).base64url(payload).base64url(Ed25519 signature) */
export function signLicense(payload: Record<string, unknown>, privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('private key must be Ed25519');
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'IAC-LICENSE' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

export function decodeChallenge(blob: string): ChallengeBlob {
  const c = JSON.parse(Buffer.from(blob.trim(), 'base64url').toString('utf8')) as Partial<ChallengeBlob>;
  if (c.v !== 1 || typeof c.nonce !== 'string' || typeof c.fingerprint !== 'string' || typeof c.expires_at !== 'string') {
    throw new Error('not a valid challenge blob');
  }
  if (new Date(c.expires_at).getTime() < Date.now()) throw new Error('challenge has expired — ask the customer for a new one');
  return c as ChallengeBlob;
}

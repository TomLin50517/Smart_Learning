import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../../common/domain-error.js';

/**
 * 授權檔驗證（ARCH §18.2、SD §8.4.3）：JWS compact，Ed25519 簽章。
 *
 * 只接受 alg=EdDSA。alg:none、HS256 等一律拒絕——防止 algorithm confusion
 * （例如把 public key 當 HMAC secret 偽造簽章）。
 */
const Header = z.object({ alg: z.literal('EdDSA'), typ: z.string().optional(), kid: z.string().optional() });

const isoOrNull = z.iso.datetime({ offset: true }).nullable();

export const LicensePayloadSchema = z
  .object({
    license_id: z.string().min(1).max(128),
    customer_id: z.string().min(1).max(128),
    edition: z.string().min(1).max(64),
    license_type: z.enum(['subscription', 'perpetual', 'trial', 'evaluation_extension']),
    issued_at: z.iso.datetime({ offset: true }),
    expires_at: isoOrNull,
    maintenance_until: isoOrNull,
    hardware_binding: z.string().min(1).max(256),
    features: z.record(z.string(), z.unknown()).default({}),
    limits: z
      .object({
        max_organizations: z.number().int().positive().optional(),
        max_active_learners: z.number().int().positive().optional(),
      })
      .default({}),
    /** 離線啟用時對應 challenge（SEQ-09）；一次性 */
    nonce: z.string().min(16).max(128).optional(),
  })
  .refine((p) => p.license_type === 'perpetual' || p.expires_at !== null, {
    message: 'time-limited licenses must have expires_at',
    path: ['expires_at'],
  });

export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

const CLOCK_SKEW_MS = 5 * 60_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function loadLicensePublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('license public key must be Ed25519');
  return key;
}

function decodeJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function verifyLicenseToken(token: string, key: KeyObject, now: Date): LicensePayload {
  const reject = (why: string) => new DomainError('LICENSE_SIGNATURE_INVALID', `License rejected: ${why}`);

  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) throw reject('malformed token');
  const [h, p, s] = parts as [string, string, string];

  let header: unknown;
  try {
    header = decodeJson(h);
  } catch {
    throw reject('malformed header');
  }
  if (!Header.safeParse(header).success) throw reject('unsupported algorithm');

  // 先驗簽，通過後才解析 payload
  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw reject('bad signature');

  let raw: unknown;
  try {
    raw = decodeJson(p);
  } catch {
    throw reject('malformed payload');
  }
  const parsed = LicensePayloadSchema.safeParse(raw);
  if (!parsed.success) throw reject('invalid payload');

  if (new Date(parsed.data.issued_at).getTime() > now.getTime() + CLOCK_SKEW_MS) throw reject('issued in the future');
  return parsed.data;
}

import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signLicense } from '../../../../../../tools/license-lib.js';
import { loadLicensePublicKey, verifyLicenseToken } from './license-token.js';

const vendor = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const pub = loadLicensePublicKey(vendor.publicKey.export({ type: 'spki', format: 'pem' }).toString());
const NOW = new Date('2026-09-11T00:00:00Z');

const payload = {
  license_id: 'lic-1',
  customer_id: 'cust-1',
  edition: 'enterprise',
  license_type: 'perpetual',
  issued_at: '2026-09-01T00:00:00Z',
  expires_at: null,
  maintenance_until: '2027-09-01T00:00:00Z',
  hardware_binding: 'sha256:machine',
  features: { ai_coach: true },
  limits: { max_organizations: 10 },
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('verifyLicenseToken', () => {
  it('accepts a license signed by the vendor key', () => {
    const p = verifyLicenseToken(signLicense(payload, vendor.privateKey), pub, NOW);
    expect(p.license_id).toBe('lic-1');
    expect(p.limits.max_organizations).toBe(10);
  });

  it('rejects a license signed by any other key', () => {
    expect(codeOf(() => verifyLicenseToken(signLicense(payload, attacker.privateKey), pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('rejects a tampered payload (e.g. raising limits)', () => {
    const [h, , s] = signLicense(payload, vendor.privateKey).split('.');
    const forged = `${h}.${b64({ ...payload, limits: { max_organizations: 9999 } })}.${s}`;
    expect(codeOf(() => verifyLicenseToken(forged, pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('rejects alg:none', () => {
    const token = `${b64({ alg: 'none' })}.${b64(payload)}.AAAA`;
    expect(codeOf(() => verifyLicenseToken(token, pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('rejects HS256 algorithm confusion (public key used as HMAC secret)', () => {
    const h = b64({ alg: 'HS256' });
    const p = b64(payload);
    const secret = vendor.publicKey.export({ type: 'spki', format: 'pem' });
    const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    expect(codeOf(() => verifyLicenseToken(`${h}.${p}.${sig}`, pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('rejects malformed input without throwing anything else', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', '!!!.???.***', `${b64({ alg: 'EdDSA' })}.not json.x`]) {
      expect(codeOf(() => verifyLicenseToken(bad, pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
    }
  });

  it('rejects a validly signed but schema-invalid payload', () => {
    const { license_id: _drop, ...noId } = payload;
    expect(codeOf(() => verifyLicenseToken(signLicense(noId, vendor.privateKey), pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('time-limited license without expires_at is invalid', () => {
    const trial = { ...payload, license_type: 'trial', expires_at: null };
    expect(codeOf(() => verifyLicenseToken(signLicense(trial, vendor.privateKey), pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('rejects a license issued in the future (beyond clock skew)', () => {
    const future = { ...payload, issued_at: '2026-09-12T00:00:00Z' };
    expect(codeOf(() => verifyLicenseToken(signLicense(future, vendor.privateKey), pub, NOW))).toBe('LICENSE_SIGNATURE_INVALID');
  });

  it('only Ed25519 public keys can be loaded', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => loadLicensePublicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toThrow(/Ed25519/);
  });
});

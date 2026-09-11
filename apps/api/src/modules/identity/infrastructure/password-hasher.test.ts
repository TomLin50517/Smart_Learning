import { argon2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PASSWORD_PARAMS, hashPassword, needsRehash, verifyPassword } from './password-hasher.js';

const FAST = { memory: 64, passes: 1, parallelism: 1, tagLength: 32 };

describe('runtime conformance', () => {
  it('Node built-in argon2id matches the RFC 9106 §5.3 test vector', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(tag.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('produces a standard PHC string with production parameters', async () => {
    const phc = await hashPassword('correct horse battery staple');
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const phc = await hashPassword('s3cret-passphrase', FAST);
    expect(await verifyPassword('s3cret-passphrase', phc)).toBe(true);
    expect(await verifyPassword('s3cret-passphrasE', phc)).toBe(false);
  });

  it('salts every hash — same password, different output', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
  });

  it('verifies hashes made with other parameters (portability / param upgrades)', async () => {
    const old = await hashPassword('legacy', { memory: 32, passes: 3, parallelism: 1, tagLength: 32 });
    expect(await verifyPassword('legacy', old)).toBe(true);
  });

  it('tampered or malformed hashes return false instead of throwing', async () => {
    const phc = await hashPassword('x', FAST);
    const tampered = phc.slice(0, -2) + (phc.endsWith('AA') ? 'BB' : 'AA');
    expect(await verifyPassword('x', tampered)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '$argon2i$v=19$m=64,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA')).toBe(false);
  });

  it('refuses absurd parameters embedded in a stored hash (DoS guard)', async () => {
    const huge = '$argon2id$v=19$m=99999999,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
    expect(await verifyPassword('x', huge)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('false for current parameters, true for weaker ones', async () => {
    expect(needsRehash(await hashPassword('p'), PASSWORD_PARAMS)).toBe(false);
    expect(needsRehash(await hashPassword('p', FAST), PASSWORD_PARAMS)).toBe(true);
  });
});

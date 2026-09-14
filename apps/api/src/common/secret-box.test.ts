import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEncryptionKey, SecretBox } from './secret-box.js';

const key = randomBytes(32);
const box = new SecretBox(key);

describe('SecretBox (AES-256-GCM, ADR-034)', () => {
  it('round-trips and never produces the same ciphertext twice', () => {
    const a = box.seal('sk-litellm-abc', 'org-1');
    const b = box.seal('sk-litellm-abc', 'org-1');
    expect(box.open(a, 'org-1')).toBe('sk-litellm-abc');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('sk-litellm');
  });

  it('refuses ciphertext moved to another owner, tampered, or opened with another key', () => {
    const s = box.seal('sk-secret', 'org-1');
    expect(() => box.open(s, 'org-2')).toThrow();
    const tampered = { ...s, ciphertext: Buffer.from(s.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 1;
    expect(() => box.open(tampered, 'org-1')).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open(s, 'org-1')).toThrow();
  });

  it('is not ready without a key; the key must be exactly 32 bytes', () => {
    expect(new SecretBox(null).ready).toBe(false);
    expect(() => new SecretBox(null).seal('x', 'o')).toThrow();
    expect(parseEncryptionKey('')).toBeNull();
    expect(parseEncryptionKey(key.toString('base64'))!.equals(key)).toBe(true);
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow();
  });
});

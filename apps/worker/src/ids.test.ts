import { VERIFICATION_CODE_PATTERN } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { newUlid, verificationCode } from './ids.js';

describe('certificate ids', () => {
  it('verification codes are 32 base32 characters (160 bits)', () => {
    expect(verificationCode(Buffer.alloc(20))).toBe('A'.repeat(32));
    expect(verificationCode(Buffer.alloc(20, 0xff))).toBe('7'.repeat(32));
    const codes = new Set(Array.from({ length: 50 }, () => verificationCode()));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(VERIFICATION_CODE_PATTERN);
  });

  it('ULIDs are 26 characters and sort by time', () => {
    expect(newUlid(0, Buffer.alloc(10))).toBe('0'.repeat(26));
    const a = newUlid(Date.UTC(2026, 0, 1));
    const b = newUlid(Date.UTC(2026, 0, 2));
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});

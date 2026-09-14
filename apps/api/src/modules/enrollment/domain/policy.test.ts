import { ENROLLMENT_CODE_PATTERN } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { generateEnrollmentCode, joinAvailability, normalizeEnrollmentCode, parsePolicy } from './policy.js';

describe('enrollment codes', () => {
  it('are 8 characters without look-alikes (0/O, 1/I) and match the DB rule', () => {
    let n = 0;
    const seq = () => n++ % 1000;
    for (let i = 0; i < 200; i++) {
      const c = generateEnrollmentCode((max) => seq() % max);
      expect(c).toMatch(ENROLLMENT_CODE_PATTERN);
      expect(c).not.toMatch(/[01IO]/);
    }
  });

  it('normalises what learners type', () => {
    expect(normalizeEnrollmentCode(' abcd-2345 ')).toBe('ABCD2345');
  });
});

describe('parsePolicy', () => {
  it('treats missing or unknown values as “assign only”', () => {
    expect(parsePolicy({})).toEqual({ joinBy: 'assign', requireApproval: false, code: null, opensAt: null, closesAt: null, maxSeats: null });
    expect(parsePolicy({ joinBy: 'magic', maxSeats: -3 })).toMatchObject({ joinBy: 'assign', maxSeats: null });
    expect(parsePolicy({ joinBy: 'code', code: 'ABCD2345', requireApproval: true, maxSeats: 30 })).toMatchObject({ joinBy: 'code', code: 'ABCD2345', requireApproval: true, maxSeats: 30 });
  });
});

describe('joinAvailability', () => {
  const now = Date.parse('2026-09-15T08:00:00Z');
  const p = { opensAt: '2026-09-01T00:00:00Z', closesAt: '2026-09-30T00:00:00Z', maxSeats: 30 };
  it.each([
    [p, 10, 'open'],
    [{ ...p, opensAt: '2026-09-20T00:00:00Z' }, 0, 'not_yet'],
    [{ ...p, closesAt: '2026-09-10T00:00:00Z' }, 0, 'closed'],
    [p, 30, 'full'],
    [{ opensAt: null, closesAt: null, maxSeats: null }, 9999, 'open'],
  ] as const)('%j with %i seats used → %s', (policy, used, expected) => {
    expect(joinAvailability(policy, used, now)).toBe(expected);
  });
});

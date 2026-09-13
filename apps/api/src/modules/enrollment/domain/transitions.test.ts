import { ENROLLMENT_STATUSES, type EnrollmentStatus } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { nextEnrollmentStatus, type EnrollmentAction } from './transitions.js';

describe('enrollment transitions (SA §7.2)', () => {
  it.each<[EnrollmentStatus, EnrollmentAction, EnrollmentStatus | null]>([
    ['active', 'suspend', 'suspended'],
    ['reopened', 'suspend', 'suspended'],
    ['suspended', 'resume', 'active'],
    ['active', 'withdraw', 'withdrawn'],
    ['suspended', 'withdraw', 'withdrawn'],
    ['pending', 'withdraw', 'withdrawn'],
    ['active', 'resume', null],
    ['suspended', 'suspend', null],
    ['completed', 'withdraw', null],
    ['withdrawn', 'withdraw', null],
    ['rejected', 'resume', null],
  ])('%s --%s--> %s', (from, action, to) => {
    expect(nextEnrollmentStatus(from, action)).toBe(to);
  });

  it('nothing leaves a terminal state through these actions', () => {
    for (const from of ENROLLMENT_STATUSES.filter((s) => s === 'withdrawn' || s === 'rejected')) {
      for (const a of ['withdraw', 'suspend', 'resume'] as const) expect(nextEnrollmentStatus(from, a)).toBeNull();
    }
  });
});

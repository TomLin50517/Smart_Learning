import { describe, expect, it } from 'vitest';
import type { CapabilityName } from '@iac/contracts';
import {
  capabilityDeniedCode,
  computeCapabilities,
  type ActivationRecord,
  type LicensePolicy,
  type LicenseRecord,
} from './compute-capabilities.js';

const NOW = new Date('2026-09-10T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const FP = 'sha256:machine-a';

const policy: LicensePolicy = {
  currentFingerprint: FP,
  graceDays: 14,
  graceAllowsConfig: false,
  graceAllowsAuthoring: false,
};
const act: ActivationRecord = { status: 'active', fingerprint: FP };

function lic(p: Partial<LicenseRecord> & Pick<LicenseRecord, 'licenseType'>): LicenseRecord {
  return {
    expiresAt: null,
    maintenanceUntil: null,
    features: { ai_coach: true },
    limits: { max_organizations: 10, max_active_learners: 5000 },
    ...p,
  };
}

//                       runtime config authoring upgrade aiCoach
type Row = [string, LicenseRecord | null, ActivationRecord | null, string, boolean, boolean, boolean, boolean, boolean];

const matrix: Row[] = [
  ['no license', null, null, 'unlicensed', false, false, false, false, false],
  ['revoked activation', lic({ licenseType: 'perpetual' }), { ...act, status: 'revoked' }, 'unlicensed', false, false, false, false, false],
  ['hardware mismatch', lic({ licenseType: 'perpetual' }), { ...act, fingerprint: 'sha256:other' }, 'unlicensed', false, false, false, false, false],
  ['trial active', lic({ licenseType: 'trial', expiresAt: day(10) }), act, 'active', true, true, true, true, true],
  ['trial day 31 (expired)', lic({ licenseType: 'trial', expiresAt: day(-1) }), act, 'blocked', false, false, false, false, false],
  ['evaluation extension active', lic({ licenseType: 'evaluation_extension', expiresAt: day(5) }), act, 'active', true, true, true, true, true],
  ['evaluation extension expired — must NOT freeze into perpetual use', lic({ licenseType: 'evaluation_extension', expiresAt: day(-1), maintenanceUntil: day(-1) }), act, 'blocked', false, false, false, false, false],
  ['subscription active', lic({ licenseType: 'subscription', expiresAt: day(30) }), act, 'active', true, true, true, true, true],
  ['subscription in grace', lic({ licenseType: 'subscription', expiresAt: day(-3) }), act, 'grace', true, false, false, false, true],
  ['subscription grace ended', lic({ licenseType: 'subscription', expiresAt: day(-15) }), act, 'blocked', false, false, false, false, false],
  ['perpetual, maintenance active', lic({ licenseType: 'perpetual', maintenanceUntil: day(100) }), act, 'active', true, true, true, true, true],
  ['perpetual, no maintenance date', lic({ licenseType: 'perpetual' }), act, 'active', true, true, true, true, true],
  ['perpetual, maintenance expired → frozen', lic({ licenseType: 'perpetual', maintenanceUntil: day(-1) }), act, 'frozen', true, false, false, false, true],
  ['perpetual frozen without ai feature', lic({ licenseType: 'perpetual', maintenanceUntil: day(-1), features: {} }), act, 'frozen', true, false, false, false, false],
];

describe('computeCapabilities (SA §7.7 matrix)', () => {
  it.each(matrix)('%s', (_n, l, a, state, runtime, config, authoring, upgrade, ai) => {
    const ev = computeCapabilities(l, a, NOW, policy);
    expect(ev.state).toBe(state);
    expect({
      runtimeAllowed: ev.runtimeAllowed,
      configurationWriteAllowed: ev.configurationWriteAllowed,
      authoringAllowed: ev.authoringAllowed,
      upgradeAllowed: ev.upgradeAllowed,
      aiCoachAllowed: ev.aiCoachAllowed,
    }).toEqual({
      runtimeAllowed: runtime,
      configurationWriteAllowed: config,
      authoringAllowed: authoring,
      upgradeAllowed: upgrade,
      aiCoachAllowed: ai,
    });
  });

  it('boundary: exactly at expiry instant is still valid', () => {
    expect(computeCapabilities(lic({ licenseType: 'trial', expiresAt: NOW }), act, NOW, policy).state).toBe('active');
  });

  it('boundary: last millisecond of grace is still grace', () => {
    const exp = day(-14);
    const lastMs = new Date(exp.getTime() + 14 * 86_400_000);
    expect(computeCapabilities(lic({ licenseType: 'subscription', expiresAt: exp }), act, lastMs, policy).state).toBe('grace');
  });

  it('grace policy can re-enable config writes', () => {
    const ev = computeCapabilities(lic({ licenseType: 'subscription', expiresAt: day(-1) }), act, NOW, {
      ...policy,
      graceAllowsConfig: true,
    });
    expect(ev.configurationWriteAllowed).toBe(true);
    expect(ev.authoringAllowed).toBe(false);
  });

  it('exposes limits for LicenseCapabilityGuard', () => {
    const ev = computeCapabilities(lic({ licenseType: 'perpetual' }), act, NOW, policy);
    expect(ev.maxOrganizations).toBe(10);
    expect(ev.maxActiveLearners).toBe(5000);
  });

  it('is pure: same inputs, same output', () => {
    const l = lic({ licenseType: 'subscription', expiresAt: day(-3) });
    expect(computeCapabilities(l, act, NOW, policy)).toEqual(computeCapabilities(l, act, NOW, policy));
  });
});

describe('capabilityDeniedCode (SD §8.4.2)', () => {
  const cases: [string, LicenseRecord | null, ActivationRecord | null, CapabilityName, string][] = [
    ['no license', null, null, 'runtimeAllowed', 'LICENSE_NOT_ACTIVATED'],
    ['hardware mismatch', lic({ licenseType: 'perpetual' }), { ...act, fingerprint: 'x' }, 'runtimeAllowed', 'LICENSE_HARDWARE_MISMATCH'],
    ['trial expired', lic({ licenseType: 'trial', expiresAt: day(-1) }), act, 'runtimeAllowed', 'LICENSE_EXPIRED'],
    ['frozen config write', lic({ licenseType: 'perpetual', maintenanceUntil: day(-1) }), act, 'configurationWriteAllowed', 'LICENSE_CONFIG_FROZEN'],
    ['frozen authoring', lic({ licenseType: 'perpetual', maintenanceUntil: day(-1) }), act, 'authoringAllowed', 'LICENSE_CONFIG_FROZEN'],
    ['active but ai feature off', lic({ licenseType: 'perpetual', features: {} }), act, 'aiCoachAllowed', 'LICENSE_FEATURE_DISABLED'],
  ];
  it.each(cases)('%s', (_n, l, a, cap, code) => {
    expect(capabilityDeniedCode(cap, computeCapabilities(l, a, NOW, policy))).toBe(code);
  });
});

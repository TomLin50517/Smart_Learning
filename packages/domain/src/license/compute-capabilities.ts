import type { ErrorCode, CapabilityName, LicenseCapabilities, LicenseType } from '@iac/contracts';

/**
 * 授權能力計算（SD §8.4.1、SA §7.7）。
 * 純函式：時間、fingerprint、policy 全由呼叫端傳入，不讀 DB、不讀時鐘。
 */

export interface LicenseRecord {
  licenseType: LicenseType;
  expiresAt: Date | null;
  maintenanceUntil: Date | null;
  features: Record<string, unknown>;
  limits: { max_organizations?: number; max_active_learners?: number };
}

export interface ActivationRecord {
  status: 'active' | 'revoked';
  fingerprint: string;
}

export interface LicensePolicy {
  currentFingerprint: string;
  graceDays: number;
  graceAllowsConfig: boolean;
  graceAllowsAuthoring: boolean;
}

export type LicenseReason =
  | 'ok'
  | 'not_activated'
  | 'hardware_mismatch'
  | 'expired'
  | 'in_grace'
  | 'maintenance_expired';

export interface LicenseEvaluation extends LicenseCapabilities {
  reason: LicenseReason;
}

const DAY_MS = 86_400_000;

function denied(reason: LicenseReason, state: 'unlicensed' | 'blocked'): LicenseEvaluation {
  return {
    state,
    reason,
    runtimeAllowed: false,
    configurationWriteAllowed: false,
    authoringAllowed: false,
    upgradeAllowed: false,
    aiCoachAllowed: false,
  };
}

function limitsOf(l: LicenseRecord): Pick<LicenseCapabilities, 'maxOrganizations' | 'maxActiveLearners'> {
  return {
    ...(l.limits.max_organizations !== undefined && { maxOrganizations: l.limits.max_organizations }),
    ...(l.limits.max_active_learners !== undefined && { maxActiveLearners: l.limits.max_active_learners }),
  };
}

function datesOf(l: LicenseRecord): Pick<LicenseCapabilities, 'expiresAt' | 'maintenanceUntil'> {
  return {
    ...(l.expiresAt && { expiresAt: l.expiresAt.toISOString() }),
    ...(l.maintenanceUntil && { maintenanceUntil: l.maintenanceUntil.toISOString() }),
  };
}

function full(l: LicenseRecord): LicenseEvaluation {
  return {
    state: 'active',
    reason: 'ok',
    runtimeAllowed: true,
    configurationWriteAllowed: true,
    authoringAllowed: true,
    upgradeAllowed: true,
    aiCoachAllowed: l.features['ai_coach'] === true,
    ...limitsOf(l),
    ...datesOf(l),
  };
}

export function computeCapabilities(
  license: LicenseRecord | null,
  activation: ActivationRecord | null,
  now: Date,
  policy: LicensePolicy,
): LicenseEvaluation {
  if (!license || !activation || activation.status !== 'active') {
    return denied('not_activated', 'unlicensed');
  }
  if (activation.fingerprint !== policy.currentFingerprint) {
    return denied('hardware_mismatch', 'unlicensed');
  }

  const aiCoach = license.features['ai_coach'] === true;

  switch (license.licenseType) {
    // trial 與 evaluation_extension 皆為硬到期（ARCH §18.1：後者是「延長 Trial」）。
    // 注意：SD v1.1 §8.4.1 曾把 evaluation_extension 歸入 perpetual，會導致
    // 延長試用在維護期後進入 Frozen 而永久可用——此處依 ARCH 修正。
    case 'trial':
    case 'evaluation_extension': {
      if (!license.expiresAt || now > license.expiresAt) {
        return { ...denied('expired', 'blocked'), ...datesOf(license) };
      }
      return full(license);
    }

    case 'subscription': {
      if (!license.expiresAt || now <= license.expiresAt) return full(license);
      const graceEnd = new Date(license.expiresAt.getTime() + policy.graceDays * DAY_MS);
      if (now <= graceEnd) {
        return {
          state: 'grace',
          reason: 'in_grace',
          runtimeAllowed: true,
          configurationWriteAllowed: policy.graceAllowsConfig,
          authoringAllowed: policy.graceAllowsAuthoring,
          upgradeAllowed: false,
          aiCoachAllowed: aiCoach,
          ...limitsOf(license),
          ...datesOf(license),
        };
      }
      return { ...denied('expired', 'blocked'), ...datesOf(license) };
    }

    case 'perpetual': {
      const maintenanceActive = !license.maintenanceUntil || now <= license.maintenanceUntil;
      if (maintenanceActive) return full(license);
      // Frozen Configuration Mode（ARCH §18.4）：學習照常，設定與內容變更全部凍結
      return {
        state: 'frozen',
        reason: 'maintenance_expired',
        runtimeAllowed: true,
        configurationWriteAllowed: false,
        authoringAllowed: false,
        upgradeAllowed: false,
        aiCoachAllowed: aiCoach,
        ...limitsOf(license),
        ...datesOf(license),
      };
    }
  }
}

/**
 * 缺少某項能力時應回的錯誤碼（SD §8.4.2）。
 * 同一個「不允許」依原因不同，對使用者的意義完全不同，因此必須區分。
 */
export function capabilityDeniedCode(capability: CapabilityName, ev: LicenseEvaluation): ErrorCode {
  switch (ev.reason) {
    case 'not_activated':
      return 'LICENSE_NOT_ACTIVATED';
    case 'hardware_mismatch':
      return 'LICENSE_HARDWARE_MISMATCH';
    case 'expired':
      return 'LICENSE_EXPIRED';
    case 'maintenance_expired':
    case 'in_grace':
      return capability === 'aiCoachAllowed' ? 'LICENSE_FEATURE_DISABLED' : 'LICENSE_CONFIG_FROZEN';
    case 'ok':
      return 'LICENSE_FEATURE_DISABLED';
  }
}

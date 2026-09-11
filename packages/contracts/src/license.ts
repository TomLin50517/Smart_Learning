/** SA §7.7 / SD §8.4 */
export type LicenseType = 'subscription' | 'perpetual' | 'trial' | 'evaluation_extension';

export type LicenseState = 'unlicensed' | 'active' | 'grace' | 'frozen' | 'blocked';

/** 可被 @RequireCapability 要求的布林能力 */
export type CapabilityName =
  | 'runtimeAllowed'
  | 'configurationWriteAllowed'
  | 'authoringAllowed'
  | 'upgradeAllowed'
  | 'aiCoachAllowed';

/** 可被 @RequireCapability({ limit }) 檢查的數量上限 */
export type LimitName = 'maxOrganizations' | 'maxActiveLearners';

export interface LicenseCapabilities {
  state: LicenseState;
  runtimeAllowed: boolean;
  configurationWriteAllowed: boolean;
  authoringAllowed: boolean;
  upgradeAllowed: boolean;
  aiCoachAllowed: boolean;
  maxOrganizations?: number;
  maxActiveLearners?: number;
  expiresAt?: string;
  maintenanceUntil?: string;
}

/** GET /api/platform/license（不含原始簽章內容） */
export interface LicenseInfo {
  license: null | {
    licenseId: string;
    customerId: string;
    edition: string;
    licenseType: LicenseType;
    issuedAt: string;
    expiresAt: string | null;
    maintenanceUntil: string | null;
    features: Record<string, unknown>;
    limits: { max_organizations?: number; max_active_learners?: number };
  };
  activation: null | {
    mode: 'online' | 'offline';
    activatedAt: string;
    lastSeenAt: string;
    /** ARCH §18.5：只是 tamper detection，不是絕對防護 */
    clockRollbackDetected: boolean;
  };
  fingerprint: { current: string; weak: boolean };
  onlineActivationAvailable: boolean;
  capabilities: LicenseCapabilities;
}

/** POST /api/platform/license/challenge（離線啟用，SEQ-09） */
export interface LicenseChallenge {
  /** 交給供應方的 challenge blob（base64url JSON） */
  challenge: string;
  fingerprint: string;
  weakFingerprint: boolean;
  expiresAt: string;
}

export const PRODUCT_VERSION = '0.1.0';

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'runtimeAllowed',
  'configurationWriteAllowed',
  'authoringAllowed',
  'upgradeAllowed',
  'aiCoachAllowed',
] as const;

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

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'runtimeAllowed',
  'configurationWriteAllowed',
  'authoringAllowed',
  'upgradeAllowed',
  'aiCoachAllowed',
] as const;

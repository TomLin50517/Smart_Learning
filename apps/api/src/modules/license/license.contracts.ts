import type { LimitName } from '@iac/contracts';
import type { LicenseEvaluation } from '@iac/domain';

/**
 * LicenseModule 對外介面。LicenseCapabilityGuard 只依賴此介面，
 * 不依賴 LicenseModule 的實作（SD §1.2 跨模組規則）。
 */
export interface LicenseEvaluator {
  evaluate(): Promise<LicenseEvaluation>;
  /** 目前用量，供 max* 上限檢查 */
  usage(limit: LimitName): Promise<number>;
}

export const LICENSE_EVALUATOR = Symbol('LICENSE_EVALUATOR');

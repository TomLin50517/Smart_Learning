import type { EnrollmentStatus } from '@iac/contracts';

/** 管理者可觸發的選課狀態轉換（SA §7.2）。完成、重新開啟、審核於後續批次 */
export type EnrollmentAction = 'withdraw' | 'suspend' | 'resume';

const TRANSITIONS: Record<EnrollmentAction, { from: readonly EnrollmentStatus[]; to: EnrollmentStatus }> = {
  withdraw: { from: ['pending', 'active', 'suspended', 'reopened'], to: 'withdrawn' },
  suspend: { from: ['active', 'reopened'], to: 'suspended' },
  // 恢復一律回到 active（reopened 被暫停後恢復，視同重新開始學習）
  resume: { from: ['suspended'], to: 'active' },
};

/** 合法時回傳新狀態，否則 null */
export function nextEnrollmentStatus(from: EnrollmentStatus, action: EnrollmentAction): EnrollmentStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : null;
}

import type { CapabilityName, LicenseState, LicenseType, OrgRole } from '@iac/contracts';

export const LICENSE_STATE_LABELS: Record<LicenseState, string> = {
  unlicensed: '尚未啟用',
  active: '有效',
  grace: '寬限期',
  frozen: '唯讀（維護期已過）',
  blocked: '已停用',
};

export const LICENSE_TYPE_LABELS: Record<LicenseType, string> = {
  subscription: '訂閱',
  perpetual: '永久授權',
  trial: '試用',
  evaluation_extension: '延長評估',
};

export const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  runtimeAllowed: '學習與系統執行',
  configurationWriteAllowed: '設定變更',
  authoringAllowed: '課程編輯',
  upgradeAllowed: '版本升級',
  aiCoachAllowed: 'AI 學習教練',
};

export const ROLE_LABELS: Record<OrgRole, string> = {
  org_admin: '組織管理員',
  course_admin: '課程管理員',
  instructor: '講師',
  learner: '學員',
  auditor: '稽核人員',
};

/** 常見稽核動作的中文名稱（SD §12.2）；未列出者顯示原始代碼 */
const ACTION_LABELS: Record<string, string> = {
  'auth.login.succeeded': '登入成功',
  'auth.login.failed': '登入失敗',
  'auth.logout': '登出',
  'auth.password_reset.requested': '申請重設密碼',
  'auth.password_reset.completed': '完成重設密碼',
  'org.created': '建立組織',
  'org.updated': '更新組織',
  'org.disabled': '停用組織',
  'org.user.created': '新增成員',
  'org.user.disabled': '停用成員',
  'org.role.assigned': '指派角色',
  'org.role.revoked': '移除角色',
  'coach.transcript.read': '檢視 Coach 對話',
  'coach.transcript_policy.updated': '變更對話可見性政策',
  'license.activated': '啟用授權',
  'license.challenge_issued': '產生授權啟用請求碼',
  'system.settings.updated': '更新平台設定',
  'audit.exported': '匯出稽核紀錄',
  'access.denied': '存取遭拒',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

const dateTime = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium' });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? dateOnly.format(new Date(iso)) : '—';
}

/** 組織品牌色只接受 #rrggbb（伺服器端亦同） */
export function brandColor(branding: Record<string, unknown> | undefined): string | null {
  const c = branding?.['primaryColor'];
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
}

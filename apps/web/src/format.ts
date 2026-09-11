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

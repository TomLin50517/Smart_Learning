import type {
  ActivityType,
  AttemptStatusTarget,
  CapabilityName,
  CoachKnowledgeScope,
  CoachLanguage,
  CoachResponseMode,
  CoachToneProfile,
  RuleConditionType,
  RuleOperator,
  CourseStatus,
  CourseVersionStatus,
  LicenseState,
  LicenseType,
  NavigationMode,
  OrgRole,
} from '@iac/contracts';

export const COURSE_STATUS_LABELS: Record<CourseStatus, string> = {
  draft: '尚未發布',
  active: '開放中',
  archived: '已封存',
};

export const VERSION_STATUS_LABELS: Record<CourseVersionStatus, string> = {
  draft: '草稿',
  review: '審閱中',
  published: '已發布',
  superseded: '已被取代',
  archived: '已封存',
};

/** 狀態徽章的樣式（沿用授權狀態的配色） */
export const VERSION_STATUS_BADGE: Record<CourseVersionStatus, string> = {
  draft: 'badge-grace',
  review: 'badge-grace',
  published: 'badge-active',
  superseded: '',
  archived: '',
};

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  video: '影片',
  quiz: '測驗',
  interactive: '互動活動',
  reading: '閱讀',
  assignment: '作業',
};

export const NAVIGATION_MODE_LABELS: Record<NavigationMode, string> = {
  strict: '依序：每個活動都要先完成前一個',
  prerequisite: '依先修條件：只套用各活動設定的先修條件',
  free: '自由：不限順序',
  mixed: '單元依序、單元內自由（預設）',
};

export const RULE_OPERATOR_LABELS: Record<RuleOperator, string> = {
  AND: '全部符合',
  OR: '任一符合',
  NOT: '不符合',
};

export const RULE_CONDITION_LABELS: Record<RuleConditionType, string> = {
  required_activities_completed: '完成所有必修活動',
  specific_activities_completed: '完成指定活動',
  minimum_score: '總分達到',
  minimum_activity_score: '活動分數達到',
  video_watch_ratio: '影片觀看比例達到',
  attempt_status: '活動作答狀態',
  module_completed: '完成單元',
  lesson_completed: '完成課節',
  time_spent_minimum: '學習時間至少',
  attempt_count_maximum: '作答次數不超過',
  manual_approval: '人工核可',
};

export const ATTEMPT_STATUS_TARGET_LABELS: Record<AttemptStatusTarget, string> = {
  passed: '通過',
  completed: '完成（含通過）',
  scored: '已有分數',
};

export const COACH_RESPONSE_MODE_LABELS: Record<CoachResponseMode, string> = {
  hint_first: '先給提示（建議）：引導學員自己想，達到嘗試次數才可給答案',
  coach_first: '引導為主：可提供部分解說',
  direct_allowed: '可直接解說：仍須附引用',
};

export const COACH_TONE_LABELS: Record<CoachToneProfile, string> = {
  supportive: '溫和鼓勵',
  neutral: '中性',
  concise: '簡潔',
};

export const COACH_KNOWLEDGE_SCOPE_LABELS: Record<CoachKnowledgeScope, string> = {
  course_source: '課程教材',
  verified_faq: '已驗證的常見問答',
  common_error: '常見錯誤說明',
  platform: '平台共用知識',
};

export const COACH_LANGUAGE_LABELS: Record<CoachLanguage, string> = {
  'zh-TW': '繁體中文',
  en: 'English',
};

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
  'org.user.enabled': '恢復成員',
  'course.created': '建立課程',
  'course.archived': '封存課程',
  'course.restored': '恢復課程',
  'course.version.created': '建立課程版本',
  'course.version.updated': '編輯課程版本',
  'course.version.cloned': '複製課程版本',
  'course.version.published': '發布課程版本',
  'course.completion_rule.updated': '更新完成條件',
  'course.coach_policy.updated': '更新 AI 教練設定',
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

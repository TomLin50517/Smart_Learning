/** 課程與課程版本（SA §5.5、§7.1；SD §2.3、§6.2.2、§6.5） */

import type { RuleNode } from './completion.js';

export type CourseStatus = 'draft' | 'active' | 'archived';
export type CourseVersionStatus = 'draft' | 'review' | 'published' | 'superseded' | 'archived';

export const NAVIGATION_MODES = ['strict', 'prerequisite', 'free', 'mixed'] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export const ACTIVITY_TYPES = ['video', 'quiz', 'interactive', 'reading', 'assignment'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** 可直接指派的課程人員角色（對應 user_org_roles 的課程範圍角色） */
export const COURSE_STAFF_ROLES = ['instructor', 'course_admin'] as const;
export type CourseStaffRole = (typeof COURSE_STAFF_ROLES)[number];

/**
 * 課程單元內容區塊（SD §7.5 的 lesson 子集）。
 * hero／announcement／course_list／footer 只用於 CMS 首頁，放進課程內容會被拒絕。
 * richtext 只存 Markdown，由前端以 allowlist 渲染；圖片／影片以 assetId 引用，不接受外部 URL。
 */
export type LessonBlock =
  | { type: 'richtext'; markdown: string }
  | { type: 'image'; assetId: string; alt: string; caption?: string }
  | { type: 'video'; assetId: string; poster?: string }
  | { type: 'callout'; variant: 'info' | 'warning' | 'success'; body: string }
  | { type: 'activity'; activityId: string };

export const LESSON_BLOCK_TYPES = ['richtext', 'image', 'video', 'callout', 'activity'] as const;

/** 草稿編輯的上限（防止病態輸入拖垮寫入與驗證） */
export const COURSE_LIMITS = {
  modules: 50,
  lessonsPerModule: 100,
  activitiesPerLesson: 50,
  activitiesTotal: 2000,
  blocksPerLesson: 200,
  markdownChars: 50_000,
  jsonBytes: 65_536,
} as const;

/**
 * 活動。answerKey 只給課程人員（持 course.version.read）；
 * 學員的 runtime 另有端點，以白名單序列化，永不含 answerKey（SD §7.3.4）。
 */
export interface ActivityDto {
  id: string;
  title: string;
  activityType: ActivityType;
  interactiveDefinitionId: string | null;
  config: Record<string, unknown>;
  answerKey: Record<string, unknown> | null;
  isRequired: boolean;
  maxAttempts: number | null;
  weight: number;
  maxScore: number;
  /** 先修條件（RuleNode）；語法驗證於發布前 validator 進行 */
  prerequisite: Record<string, unknown> | null;
}

export interface LessonDto {
  id: string;
  title: string;
  isRequired: boolean;
  contentBlocks: LessonBlock[];
  activities: ActivityDto[];
}

export interface ModuleDto {
  id: string;
  title: string;
  description: string | null;
  isRequired: boolean;
  lessons: LessonDto[];
}

export interface CourseVersionSummaryDto {
  id: string;
  versionNo: number;
  status: CourseVersionStatus;
  title: string;
  publishedAt: string | null;
  createdAt: string;
  clonedFromVersionId: string | null;
}

export interface CourseVersionDetailDto extends CourseVersionSummaryDto {
  courseId: string;
  organizationId: string;
  summary: string | null;
  navigationMode: NavigationMode;
  modules: ModuleDto[];
  completionRuleSet: { grammarVersion: string; rule: RuleNode } | null;
  coachPolicy: CoachPolicyDto | null;
  knowledgeBindings: { documentVersionId: string; bindingType: string; priority: number }[];
  /** 發布時計算的內容雜湊（`sha256:…`）；草稿為 null（SA AC-CRS-001 的偵測手段） */
  contentSnapshotHash: string | null;
  /** 等同 status === 'draft'；false 時所有內容寫入回 409 COURSE_VERSION_IMMUTABLE */
  editable: boolean;
}

/**
 * AI 教練設定（SD §2.3 coach_policies、§10.1.2 POLICY 段）。隨版本凍結：已發布版本不可修改。
 * 值域以白名單限定——這些值會組進送給 AI 的提示詞。
 */
export const COACH_RESPONSE_MODES = ['hint_first', 'coach_first', 'direct_allowed'] as const;
export type CoachResponseMode = (typeof COACH_RESPONSE_MODES)[number];
export const COACH_TONE_PROFILES = ['supportive', 'neutral', 'concise'] as const;
export type CoachToneProfile = (typeof COACH_TONE_PROFILES)[number];
/** 對應知識索引的 knowledge_type（SD §4.2）：教材、已驗證 FAQ、常見錯誤、平台知識 */
export const COACH_KNOWLEDGE_SCOPES = ['course_source', 'verified_faq', 'common_error', 'platform'] as const;
export type CoachKnowledgeScope = (typeof COACH_KNOWLEDGE_SCOPES)[number];
export const COACH_LANGUAGES = ['zh-TW', 'en'] as const;
export type CoachLanguage = (typeof COACH_LANGUAGES)[number];
export const COACH_POLICY_LIMITS = { revealAfterMax: 20, prohibitedTopics: 20, topicChars: 100, extraInstructionsChars: 1000 } as const;

export interface CoachPolicyDto {
  responseMode: CoachResponseMode;
  /** 1（只給提示）～5（可完整解說） */
  maxDirectnessLevel: number;
  /** 嘗試幾次後可直接給答案；null＝永不 */
  allowAnswerRevealAfterAttempts: number | null;
  preferredLanguage: CoachLanguage;
  citationRequired: boolean;
  allowedKnowledgeScopes: CoachKnowledgeScope[];
  toneProfile: CoachToneProfile;
  followUpQuestions: boolean;
  prohibitedTopics: string[];
  extraInstructions: string | null;
}

export interface CourseDto {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  description: string | null;
  status: CourseStatus;
  createdAt: string;
  /** 目前生效的已發布版本（同一課程至多一個，AC-CRS-007） */
  publishedVersion: { id: string; versionNo: number } | null;
  /** 編輯中的版本（draft／review；同一課程同時至多一個） */
  workingVersion: { id: string; versionNo: number; status: CourseVersionStatus } | null;
  /** 啟用中的課程人員，講師在前（列表的「講師」欄；完整名冊見 GET /courses/{id}/staff） */
  staff: { userId: string; displayName: string; role: CourseStaffRole }[];
}

export interface CourseDetailDto extends CourseDto {
  versions: CourseVersionSummaryDto[];
}

export interface CourseStaffDto {
  userId: string;
  displayName: string;
  email: string;
  role: CourseStaffRole;
  assignedAt: string;
  /** 在課程所屬組織的成員資格已停用（角色保留但沒有權限；名冊照列並標示，課程列表的講師欄不列） */
  memberDisabled: boolean;
}

export interface VersionImpactDto {
  /** pending／active／suspended／reopened 的選課 */
  activeLearners: number;
  completedLearners: number;
  boundDocumentVersions: number;
}

export interface InteractiveDefinitionDto {
  id: string;
  componentType: string;
  schemaVersion: string;
  displayName: string;
  configSchema: Record<string, unknown>;
}

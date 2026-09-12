/** 課程與課程版本（SA §5.5、§7.1；SD §2.3、§6.2.2、§6.5） */

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
  completionRuleSet: { grammarVersion: string; rule: Record<string, unknown> } | null;
  coachPolicy: Record<string, unknown> | null;
  knowledgeBindings: { documentVersionId: string; bindingType: string; priority: number }[];
  /** 等同 status === 'draft'；false 時所有內容寫入回 409 COURSE_VERSION_IMMUTABLE */
  editable: boolean;
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

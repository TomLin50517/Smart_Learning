/** 學習 Runtime、作答與完成判定（SA §7.3、SEQ-03、UC-LRN-*；SD §6.2.3、§6.9） */

import type { ApproverRole, BlockingReason, RuleTraceEntry, Tri } from './completion.js';
import type { ActivityType, LessonBlock, NavigationMode } from './course.js';
import type { EnrollmentDto, EnrollmentStatus } from './enrollment.js';

export const RESULT_STATUSES = ['passed', 'completed', 'needs_improvement', 'failed'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const ATTEMPT_STATUSES = ['in_progress', 'submitted', 'scored', 'abandoned'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** 沒有互動元件的活動使用的內建元件（componentType） */
export const BUILTIN_COMPONENTS = { reading: 'builtin.reading', video: 'builtin.video', quiz: 'builtin.quiz' } as const;

// ---- 內建元件的 config／input 形狀（前端元件與伺服器 evaluator 共用） -----------------

/** 選擇題：題目與選項在 config；正解在 answerKey（只存在伺服器） */
export interface ChoiceQuizConfig {
  instructions?: string;
  questions: { id: string; prompt: string; multiple?: boolean; options: { id: string; label: string }[] }[];
}
export interface ChoiceQuizAnswerKey {
  correct: Record<string, string[]>;
  /** 通過門檻（答對比例 %），預設 60 */
  pass_threshold?: number;
}
export interface ChoiceQuizInput {
  answers: Record<string, string[]>;
}
/**
 * 影片：config.video_url 有設定時，伺服器以學習事件（video.progressed 的觀看區間）計算觀看比例，
 * 忽略學員端送來的 watchedRatio；未設定影片網址（依老師指示在別處觀看）才採用學員的確認（SD §6.12）。
 * 比例達 config.completion_ratio（預設 0.9）才算完成。
 */
export interface VideoConfig {
  video_url?: string;
  /** 影片長度（秒）；未設定時以播放器回報的長度為準 */
  duration_sec?: number;
  completion_ratio?: number;
  instructions?: string;
}
export interface VideoInput {
  watchedRatio?: number;
}
export interface ParameterControlInput {
  values: Record<string, number>;
}
/** StepSequence／Timeline：項目 id 的排列 */
export interface SequenceInput {
  order: string[];
}

// ---- API DTO --------------------------------------------------------------------------

export interface ResultIssue {
  code: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  /** 問題所在的題目／參數／項目 id */
  target?: string;
}

/** GET /activities/{id}/runtime。config 為白名單序列化，永不含 answerKey（SA THR-T-002） */
export interface ActivityRuntimeDto {
  activityId: string;
  enrollmentId: string;
  title: string;
  activityType: ActivityType;
  componentType: string;
  schemaVersion: string;
  config: Record<string, unknown>;
  /** 伺服器有對應的評分器；false 時前端顯示「尚未支援」 */
  supported: boolean;
  attemptPolicy: { maxAttempts: number | null; usedAttempts: number };
  inProgressAttemptId: string | null;
  previousResultSummary: { status: ResultStatus; score: number | null; maxScore: number; attemptNo: number } | null;
  coachAvailable: boolean;
}

export interface ActivityResultDto {
  attemptId: string;
  attemptNo: number;
  status: ResultStatus;
  score: number | null;
  maxScore: number;
  issues: ResultIssue[];
  feedbackData: Record<string, unknown>;
  evaluatedAt: string;
  /** 這次送出讓選課轉為已完成 */
  completionChanged: boolean;
}

export interface ProgressDto {
  requiredTotal: number;
  requiredCompleted: number;
  /** 必修且有分數的加權總分（0～100）；尚無分數為 null */
  weightedScore: number | null;
  /** 完成條件成立 */
  completed: boolean;
  value: Tri;
  blockingReasons: BlockingReason[];
}

/** SD §3.5；GET /enrollments/{id}/completion */
export interface CompletionEvaluationDto extends ProgressDto {
  enrollmentId: string;
  grammarVersion: string | null;
  evaluatedAt: string;
  result: boolean;
  trace: RuleTraceEntry[];
}

export type OutlineActivityState = 'locked' | 'available' | 'in_progress' | 'attempted' | 'completed';

export interface OutlineActivityDto {
  id: string;
  title: string;
  activityType: ActivityType;
  isRequired: boolean;
  supported: boolean;
  state: OutlineActivityState;
  /** 鎖定原因：sequence＝學習順序；prerequisite＝先修條件 */
  lockReason: 'sequence' | 'prerequisite' | null;
  best: { status: ResultStatus; score: number | null; maxScore: number } | null;
  attempts: number;
  maxAttempts: number | null;
  /** 影片活動的觀看比例（0～1）；非影片為 null */
  watchedRatio: number | null;
  /** 在目前的重修範圍內、且重修之後尚未完成（SD §6.25） */
  inRelearning: boolean;
}

// ---- 重修（SA UC-ENR-007、SD §6.25） ------------------------------------------------------

export const RELEARNING_SCOPES = ['course', 'module', 'lesson', 'activity'] as const;
export type RelearningScope = (typeof RELEARNING_SCOPES)[number];
/** reset_counter：作答次數從這次重修重新計算（預設）；append：沿用已用的次數 */
export const NEW_ATTEMPT_POLICIES = ['reset_counter', 'append'] as const;
export type NewAttemptPolicy = (typeof NEW_ATTEMPT_POLICIES)[number];

/** 重修指派：範圍內的活動只採計指派之後的結果；歷史作答與結果完整保留（INV-6） */
export interface RelearningDto {
  id: string;
  enrollmentId: string;
  scopeType: RelearningScope;
  /** course 為 null */
  scopeId: string | null;
  /** 單元／課節／活動名稱；course 為 null */
  scopeTitle: string | null;
  reason: string;
  dueDate: string | null;
  newAttemptPolicy: NewAttemptPolicy;
  assignedAt: string;
  assignedByName: string;
}

/** POST /enrollments/{id}/relearning */
export interface RelearningResultDto {
  relearning: RelearningDto;
  enrollment: EnrollmentDto;
}

/** 有效學習時間（SD §6.12）：相鄰學習事件的間隔加總，離開超過 5 分鐘的間隔不計 */
export interface LearningTimeDto {
  minutes: number;
  byModule: { moduleId: string; title: string; minutes: number }[];
  lastActivityAt: string | null;
}

/** GET /enrollments/{id}/outline：學員的課程大綱（不含活動設定與答案） */
export interface LearnerOutlineDto {
  enrollment: { id: string; status: EnrollmentStatus; canLearn: boolean; courseId: string; courseTitle: string; versionNo: number };
  navigationMode: NavigationMode;
  modules: {
    id: string;
    title: string;
    description: string | null;
    isRequired: boolean;
    lessons: { id: string; title: string; isRequired: boolean; contentBlocks: LessonBlock[]; activities: OutlineActivityDto[] }[];
  }[];
  progress: ProgressDto;
  time: LearningTimeDto;
  /** 進行中的重修（最新一筆指派，且範圍內還有未完成的活動）；沒有則為 null */
  relearning: RelearningDto | null;
}

/** GET /enrollments/{id}/progress：課程人員檢視單一學員（大綱＋學員資料） */
export interface LearnerProgressDto extends LearnerOutlineDto {
  learner: { id: string; displayName: string; email: string; memberNo: string | null; cohortLabel: string | null };
  /** 所有重修指派（新到舊） */
  relearnings: RelearningDto[];
  /** 人工核可（SD §6.14）：完成條件要求的核可者角色與已有的核可 */
  approval: {
    required: ApproverRole[];
    given: { approverRole: string; approverName: string; approvedAt: string; note: string | null }[];
  };
}

/** POST /enrollments/{id}/completion-approvals */
export interface CompletionApprovalDto {
  approvedRoles: ApproverRole[];
  /** 這次核可讓選課轉為已完成（會排入發證） */
  completionChanged: boolean;
}

// ---- 學習事件（SA §10、SD §6.12） ------------------------------------------------------

/** 學員端可送出的事件；其餘事件只由伺服器產生 */
export const CLIENT_EVENT_TYPES = ['video.started', 'video.progressed', 'activity.input_changed', 'activity.heartbeat'] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export const EVENT_BATCH_MAX = 50;
/** 每筆選課每分鐘最多接收的事件數（超過 429，不阻斷學習） */
export const EVENTS_PER_MINUTE = 120;
/** 學習畫面在前景時送 heartbeat 的間隔 */
export const HEARTBEAT_INTERVAL_SEC = 60;
/** video.progressed 的取樣間隔 */
export const VIDEO_SAMPLE_SEC = 15;

export interface LearningEventInput {
  eventId: string;
  eventType: string;
  eventVersion: '1.0';
  occurredAt: string;
  activityId?: string;
  payload: Record<string, unknown>;
}

export interface LearningEventBatchResponse {
  accepted: number;
  duplicated: number;
  rejected: { eventId: string; reason: string }[];
}

export interface TimelineItemDto {
  id: string;
  eventType: string;
  occurredAt: string;
  activityId: string | null;
  activityTitle: string | null;
  attemptId: string | null;
  /** 依事件類型白名單挑出的細節（例：attemptNo、status、score、method） */
  details: Record<string, string | number | boolean | null>;
}

/** GET /enrollments/{id}/timeline、GET /me/enrollments/{id}/timeline */
export interface EnrollmentTimelineDto {
  data: TimelineItemDto[];
  meta: { next_cursor: string | null };
  time: LearningTimeDto;
}

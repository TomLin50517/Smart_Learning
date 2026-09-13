/** 學習 Runtime、作答與完成判定（SA §7.3、SEQ-03、UC-LRN-*；SD §6.2.3、§6.9） */

import type { BlockingReason, RuleTraceEntry, Tri } from './completion.js';
import type { ActivityType, LessonBlock, NavigationMode } from './course.js';
import type { EnrollmentStatus } from './enrollment.js';

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
/** 影片：觀看比例 0～1；config.completion_ratio（預設 0.9）以上才算完成 */
export interface VideoInput {
  watchedRatio: number;
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
}

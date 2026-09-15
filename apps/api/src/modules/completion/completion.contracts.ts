/**
 * MOD-COMPLETE 對外介面。其他模組只能 import 此檔或 completion.module.ts（SD §1.2、.dependency-cruiser.cjs）。
 */
import type { ActivityType, CompletionEvaluationDto, EnrollmentStatus, LessonBlock, NavigationMode, RelearningDto, RuleNode } from '@iac/contracts';
import type { CompletionContext } from '@iac/domain';
import type pg from 'pg';

export interface ProgressActivity {
  id: string;
  title: string;
  activityType: ActivityType;
  /** 有效必修：活動、課節、單元皆必修 */
  isRequired: boolean;
  interactiveDefinitionId: string | null;
  serverEvaluator: string | null;
  maxAttempts: number | null;
  weight: number;
  maxScore: number;
  prerequisite: RuleNode | null;
  /** 影片活動的 config.video_url；設定時觀看比例以學習事件佐證 */
  videoUrl: string | null;
}

/** 某筆選課的學習進度：課程結構（依排序）、完成條件與評估上下文 */
export interface EnrollmentProgress {
  enrollment: { id: string; userId: string; organizationId: string; courseId: string; courseVersionId: string; status: EnrollmentStatus };
  navigationMode: NavigationMode;
  modules: {
    id: string;
    title: string;
    description: string | null;
    isRequired: boolean;
    lessons: { id: string; title: string; isRequired: boolean; contentBlocks: LessonBlock[]; activities: ProgressActivity[] }[];
  }[];
  rule: { grammarVersion: string; rule: RuleNode } | null;
  /** 評估上下文：重修範圍內的活動只含指派之後的結果（SD §6.25） */
  ctx: CompletionContext;
  /** 每個活動已送出的作答數（reset_counter 的重修只算重修之後）與進行中的作答 */
  attempts: Record<string, { used: number; inProgressId: string | null }>;
  /** 有效學習時間（秒；SD §6.12）與最後一筆學習事件的時間 */
  time: { totalSec: number; byModuleSec: Record<string, number>; lastActivityAt: string | null };
  /** 重修（SD §6.25）：所有指派（新到舊）、各活動目前生效的指派、最新一筆整門課重修的時間（在此之前的人工核可不計） */
  relearning: { assignments: RelearningDto[]; byActivity: Record<string, string>; courseCutoffAt: string | null };
}

export interface CompletionEngine {
  /** 讀取進度（唯一碰 DB 的步驟）；可在呼叫端的交易內執行 */
  progress(enrollmentId: string, q?: pg.Pool | pg.PoolClient): Promise<EnrollmentProgress>;
  /** 評估完成條件（純計算，不寫入） */
  evaluate(p: EnrollmentProgress): CompletionEvaluationDto;
  /** 只寫入進度快照，不改選課狀態（例如指派重修後更新名單上的進度） */
  snapshot(p: EnrollmentProgress, evaluation: CompletionEvaluationDto, c: pg.PoolClient): Promise<void>;
  /** 寫入進度快照；成立時選課轉 completed。回傳是否因此完成 */
  persist(p: EnrollmentProgress, evaluation: CompletionEvaluationDto, c: pg.PoolClient): Promise<boolean>;
}

export const COMPLETION_ENGINE = Symbol('COMPLETION_ENGINE');

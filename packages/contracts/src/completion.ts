/**
 * 完成條件語法（SD §3）。型別放在 contracts：前端的條件編輯器與 API 共用；
 * 評估與驗證邏輯是純函式，位於 @iac/domain（前端不得依賴 domain）。
 */

export const RULE_GRAMMAR_VERSION = '1.0';

/** 巢狀深度（根為第 1 層）與條件總數上限（SD §3.6） */
export const RULE_LIMITS = { maxDepth: 5, maxConditions: 50 } as const;

export const RULE_OPERATORS = ['AND', 'OR', 'NOT'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const RULE_CONDITION_TYPES = [
  'required_activities_completed',
  'specific_activities_completed',
  'minimum_score',
  'minimum_activity_score',
  'video_watch_ratio',
  'attempt_status',
  'module_completed',
  'lesson_completed',
  'time_spent_minimum',
  'attempt_count_maximum',
  'manual_approval',
] as const;
export type RuleConditionType = (typeof RULE_CONDITION_TYPES)[number];

/** 先修條件只用得到與單一活動／範圍進度相關的子集（SD §3.7） */
export const PREREQUISITE_CONDITION_TYPES = [
  'specific_activities_completed',
  'minimum_activity_score',
  'attempt_status',
  'module_completed',
  'lesson_completed',
] as const satisfies readonly RuleConditionType[];

export const ATTEMPT_STATUS_TARGETS = ['passed', 'completed', 'scored'] as const;
export type AttemptStatusTarget = (typeof ATTEMPT_STATUS_TARGETS)[number];

/** manual_approval 可指定的核可者角色 */
export const APPROVER_ROLES = ['instructor', 'course_admin', 'org_admin'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

export interface RuleGroup {
  operator: RuleOperator;
  /** NOT 群組只能有一個條件 */
  conditions: RuleNode[];
}

export type RuleCondition = (
  | { type: 'required_activities_completed'; value: boolean }
  | { type: 'specific_activities_completed'; activity_ids: string[] }
  | { type: 'minimum_score'; value: number }
  | { type: 'minimum_activity_score'; activity_id: string; value: number }
  | { type: 'video_watch_ratio'; activity_id: string; value: number }
  | { type: 'attempt_status'; activity_id: string; value: AttemptStatusTarget }
  | { type: 'module_completed'; module_id: string }
  | { type: 'lesson_completed'; lesson_id: string }
  | { type: 'time_spent_minimum'; value: number; scope?: 'course' | 'module'; scope_id?: string }
  | { type: 'attempt_count_maximum'; activity_id: string; value: number }
  | { type: 'manual_approval'; approver_role: ApproverRole }
) & { negate?: boolean };

export type RuleNode = RuleGroup | RuleCondition;

/** 三值邏輯（SD §3.3）：只有 TRUE 算完成；UNKNOWN 表示資料不足，與「還沒做」的 FALSE 區分 */
export type Tri = 'TRUE' | 'FALSE' | 'UNKNOWN';

export const RULE_ISSUE_CODES = [
  'RULE_SCHEMA_INVALID',
  'RULE_DEPTH_EXCEEDED',
  'RULE_TOO_COMPLEX',
  'RULE_REFERENCE_NOT_FOUND',
  'RULE_TYPE_MISMATCH',
  'RULE_VALUE_OUT_OF_RANGE',
  'RULE_UNSATISFIABLE',
] as const;
export type RuleIssueCode = (typeof RULE_ISSUE_CODES)[number];

/** 驗證問題（SD §6.2.2）。path 為 JSON 路徑，如 `$.conditions[1].activity_id` */
export interface ValidationIssueDto {
  code: string;
  path: string;
  message: string;
  targetId?: string;
}

export interface ValidationReportDto {
  valid: boolean;
  errors: ValidationIssueDto[];
  warnings: ValidationIssueDto[];
}

/** 評估輸出（SD §3.5） */
export interface RuleTraceEntry {
  path: string;
  /** 條件類型，或群組的運算子 */
  type: string;
  result: Tri;
  detail?: Record<string, unknown>;
}

export interface BlockingReason {
  code: string;
  activity_id: string | null;
  actual?: unknown;
  required?: unknown;
}

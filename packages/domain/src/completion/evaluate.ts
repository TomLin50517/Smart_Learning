import { RULE_LIMITS, type BlockingReason, type RuleCondition, type RuleNode, type RuleTraceEntry, type Tri } from '@iac/contracts';

/**
 * 評估上下文（SD §3.2）：唯一輸入、純資料。建構它是唯一會碰資料庫的步驟；
 * 評估器本身無 I/O，可重放、可靜態驗證不含 HTTP 呼叫（SA INV-T3）。
 */
export interface CompletionContext {
  requiredActivityIds: readonly string[];
  activities: Record<string, { weight: number; maxScore: number; moduleId: string; lessonId: string; activityType: string }>;
  bestResults: Record<string, { status: string; score: number | null } | undefined>;
  attemptCounts: Record<string, number>;
  videoWatchRatios: Record<string, number>;
  timeSpentMinutes: { course: number; byModule: Record<string, number> };
  manualApprovals: readonly { approverRole: string; approvedAt: string }[];
}

export interface EvaluationResult {
  /** 只有整體為 TRUE 才算完成 */
  result: boolean;
  value: Tri;
  trace: RuleTraceEntry[];
  /** 未成立的條件（UNKNOWN 以 DATA_NOT_AVAILABLE 表示）；整體成立時為空 */
  blockingReasons: BlockingReason[];
}

export class RuleDepthExceededError extends Error {
  constructor() {
    super(`Rule nesting exceeds ${RULE_LIMITS.maxDepth} levels`);
    this.name = 'RuleDepthExceededError';
  }
}

const DONE = new Set(['passed', 'completed']);

export const triNot = (v: Tri): Tri => (v === 'TRUE' ? 'FALSE' : v === 'FALSE' ? 'TRUE' : 'UNKNOWN');

/** SD §3.3 真值表：AND 有 FALSE 即 FALSE；OR 有 TRUE 即 TRUE；其餘有 UNKNOWN 即 UNKNOWN */
export function triAnd(values: readonly Tri[]): Tri {
  if (values.includes('FALSE')) return 'FALSE';
  return values.includes('UNKNOWN') ? 'UNKNOWN' : 'TRUE';
}

export function triOr(values: readonly Tri[]): Tri {
  if (values.includes('TRUE')) return 'TRUE';
  return values.includes('UNKNOWN') ? 'UNKNOWN' : 'FALSE';
}

interface Outcome {
  value: Tri;
  detail?: Record<string, unknown>;
  /** 條件本身（未套用 negate）不成立時的原因 */
  reason?: BlockingReason;
}

const round = (n: number) => Math.round(n * 100) / 100;

function evaluateCondition(c: RuleCondition, ctx: CompletionContext): Outcome {
  const done = (id: string) => {
    const r = ctx.bestResults[id];
    return !!r && DONE.has(r.status);
  };
  const tri = (ok: boolean): Tri => (ok ? 'TRUE' : 'FALSE');

  switch (c.type) {
    case 'required_activities_completed': {
      if (!c.value) return { value: 'TRUE' };
      const required = ctx.requiredActivityIds.length;
      const completed = ctx.requiredActivityIds.filter(done).length;
      // 沒做是明確的未完成：FALSE，不是 UNKNOWN（SD §3.4）
      return {
        value: tri(completed === required),
        detail: { completed, required },
        reason: { code: 'REQUIRED_ACTIVITIES_INCOMPLETE', activity_id: null, actual: completed, required },
      };
    }
    case 'specific_activities_completed': {
      const missing = c.activity_ids.filter((id) => !done(id));
      return {
        value: tri(missing.length === 0),
        detail: { missing },
        reason: { code: 'ACTIVITY_NOT_COMPLETED', activity_id: missing[0] ?? null, actual: c.activity_ids.length - missing.length, required: c.activity_ids.length },
      };
    }
    case 'minimum_score': {
      // 加權總分：只計必修且有分數的活動；不計分的活動（閱讀等，完成但 score 為 null）不列入。
      // 有必修活動尚未作答時無法得知總分 → UNKNOWN
      let num = 0;
      let den = 0;
      for (const id of ctx.requiredActivityIds) {
        const a = ctx.activities[id];
        const r = ctx.bestResults[id];
        if (!a) continue;
        if (!r) return { value: 'UNKNOWN', detail: { pending: id }, reason: { code: 'DATA_NOT_AVAILABLE', activity_id: id } };
        if (r.score === null) continue;
        num += r.score * a.weight;
        den += a.maxScore * a.weight;
      }
      if (den === 0) return { value: 'UNKNOWN', detail: { scored: 0 }, reason: { code: 'DATA_NOT_AVAILABLE', activity_id: null } };
      const actual = round((num / den) * 100);
      return { value: tri(actual >= c.value), detail: { actual, required: c.value }, reason: { code: 'MIN_SCORE_NOT_MET', activity_id: null, actual, required: c.value } };
    }
    case 'minimum_activity_score': {
      const score = ctx.bestResults[c.activity_id]?.score ?? null;
      return {
        value: tri(score !== null && score >= c.value),
        detail: { actual: score, required: c.value },
        reason: { code: 'ACTIVITY_SCORE_NOT_MET', activity_id: c.activity_id, actual: score, required: c.value },
      };
    }
    case 'video_watch_ratio': {
      // 目標不是影片 → 設定錯誤（發布前 validator 會擋），評估時視為 UNKNOWN
      if (ctx.activities[c.activity_id]?.activityType !== 'video') return { value: 'UNKNOWN', reason: { code: 'DATA_NOT_AVAILABLE', activity_id: c.activity_id } };
      const actual = ctx.videoWatchRatios[c.activity_id] ?? 0;
      return {
        value: tri(actual >= c.value),
        detail: { actual, required: c.value },
        reason: { code: 'VIDEO_WATCH_RATIO_NOT_MET', activity_id: c.activity_id, actual, required: c.value },
      };
    }
    case 'attempt_status': {
      const r = ctx.bestResults[c.activity_id];
      const ok = !!r && (c.value === 'passed' ? r.status === 'passed' : c.value === 'completed' ? DONE.has(r.status) : r.score !== null);
      return { value: tri(ok), detail: { status: r?.status ?? null }, reason: { code: 'ATTEMPT_STATUS_NOT_MET', activity_id: c.activity_id, actual: r?.status ?? null, required: c.value } };
    }
    case 'module_completed':
    case 'lesson_completed': {
      const inScope =
        c.type === 'module_completed'
          ? (id: string) => ctx.activities[id]?.moduleId === c.module_id
          : (id: string) => ctx.activities[id]?.lessonId === c.lesson_id;
      const ids = ctx.requiredActivityIds.filter(inScope);
      // 範圍內沒有必修活動 → 無從判定（UNKNOWN），validator 會先警告
      if (ids.length === 0) return { value: 'UNKNOWN', reason: { code: 'DATA_NOT_AVAILABLE', activity_id: null } };
      const completed = ids.filter(done).length;
      const code = c.type === 'module_completed' ? 'MODULE_NOT_COMPLETED' : 'LESSON_NOT_COMPLETED';
      return { value: tri(completed === ids.length), detail: { completed, required: ids.length }, reason: { code, activity_id: null, actual: completed, required: ids.length } };
    }
    case 'time_spent_minimum': {
      const actual = c.scope === 'module' ? (ctx.timeSpentMinutes.byModule[c.scope_id ?? ''] ?? 0) : ctx.timeSpentMinutes.course;
      return { value: tri(actual >= c.value), detail: { actual, required: c.value }, reason: { code: 'TIME_SPENT_NOT_MET', activity_id: null, actual, required: c.value } };
    }
    case 'attempt_count_maximum': {
      if (!done(c.activity_id)) return { value: 'FALSE', reason: { code: 'ACTIVITY_NOT_COMPLETED', activity_id: c.activity_id } };
      const actual = ctx.attemptCounts[c.activity_id] ?? 0;
      return {
        value: tri(actual <= c.value),
        detail: { actual, maximum: c.value },
        reason: { code: 'ATTEMPT_COUNT_EXCEEDED', activity_id: c.activity_id, actual, required: c.value },
      };
    }
    case 'manual_approval': {
      const ok = ctx.manualApprovals.some((a) => a.approverRole === c.approver_role);
      return { value: tri(ok), reason: { code: 'MANUAL_APPROVAL_PENDING', activity_id: null, required: c.approver_role } };
    }
  }
}

/**
 * 完成條件評估（SD §3.4）。純函式、O(條件數)。
 * trace 以後序記錄每個節點；blockingReasons 列出所有未成立的條件（OR 分支中未成立者也列出，
 * 讓學員看到每條可行的路還差什麼）。
 */
export function evaluateRule(rule: RuleNode, ctx: CompletionContext): EvaluationResult {
  const trace: RuleTraceEntry[] = [];
  const unmet: BlockingReason[] = [];

  const visit = (node: RuleNode, path: string, depth: number): Tri => {
    if (depth > RULE_LIMITS.maxDepth) throw new RuleDepthExceededError();
    if ('operator' in node) {
      const values = node.conditions.map((child, i) => visit(child, `${path}.conditions[${i}]`, depth + 1));
      // NOT 群組只有一個條件（validator 保證）；若有多個，視為 NOT(AND(...))
      const value = node.operator === 'AND' ? triAnd(values) : node.operator === 'OR' ? triOr(values) : triNot(triAnd(values));
      trace.push({ path, type: node.operator, result: value });
      return value;
    }
    const o = evaluateCondition(node, ctx);
    const value = node.negate ? triNot(o.value) : o.value;
    trace.push({ path, type: node.type, result: value, ...(o.detail && { detail: o.detail }) });
    if (value === 'UNKNOWN') unmet.push({ code: 'DATA_NOT_AVAILABLE', activity_id: o.reason?.activity_id ?? null });
    else if (value === 'FALSE') unmet.push(node.negate ? { code: 'NEGATED_CONDITION_MET', activity_id: o.reason?.activity_id ?? null } : o.reason!);
    return value;
  };

  const value = visit(rule, '$', 1);
  return { result: value === 'TRUE', value, trace, blockingReasons: value === 'TRUE' ? [] : unmet };
}

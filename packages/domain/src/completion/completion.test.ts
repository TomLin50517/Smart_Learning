import type { RuleNode, Tri } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateRule, RuleDepthExceededError, triAnd, triNot, triOr, type CompletionContext } from './evaluate.js';
import { validateRule, type RuleStructure } from './validate-rule.js';

const M1 = '10000000-0000-0000-0000-000000000001';
const M2 = '10000000-0000-0000-0000-000000000002';
const L1 = '20000000-0000-0000-0000-000000000001';
const L2 = '20000000-0000-0000-0000-000000000002';
const QUIZ = '30000000-0000-0000-0000-000000000001';
const READ = '30000000-0000-0000-0000-000000000002';
const VIDEO = '30000000-0000-0000-0000-000000000003';
const OPTIONAL = '30000000-0000-0000-0000-000000000004';
const GHOST = '99999999-0000-0000-0000-000000000000';

const structure: RuleStructure = {
  activities: {
    [QUIZ]: { activityType: 'quiz', moduleId: M1, lessonId: L1, isRequired: true, maxScore: 100 },
    [READ]: { activityType: 'reading', moduleId: M1, lessonId: L1, isRequired: true, maxScore: 100 },
    [VIDEO]: { activityType: 'video', moduleId: M2, lessonId: L2, isRequired: true, maxScore: 10 },
    [OPTIONAL]: { activityType: 'quiz', moduleId: M2, lessonId: L2, isRequired: false, maxScore: 100 },
  },
  moduleIds: [M1, M2],
  lessonIds: [L1, L2],
};

const baseCtx = (over: Partial<CompletionContext> = {}): CompletionContext => ({
  requiredActivityIds: [QUIZ, READ, VIDEO],
  activities: {
    [QUIZ]: { weight: 2, maxScore: 100, moduleId: M1, lessonId: L1, activityType: 'quiz' },
    [READ]: { weight: 1, maxScore: 100, moduleId: M1, lessonId: L1, activityType: 'reading' },
    [VIDEO]: { weight: 1, maxScore: 10, moduleId: M2, lessonId: L2, activityType: 'video' },
    [OPTIONAL]: { weight: 1, maxScore: 100, moduleId: M2, lessonId: L2, activityType: 'quiz' },
  },
  bestResults: {},
  attemptCounts: {},
  videoWatchRatios: {},
  timeSpentMinutes: { course: 0, byModule: {} },
  manualApprovals: [],
  ...over,
});

const allDone = (): CompletionContext['bestResults'] => ({
  [QUIZ]: { status: 'passed', score: 80 },
  [READ]: { status: 'completed', score: null },
  [VIDEO]: { status: 'completed', score: 6 },
});

describe('three-valued logic (SD §3.3 truth table)', () => {
  const T: Tri = 'TRUE';
  const F: Tri = 'FALSE';
  const U: Tri = 'UNKNOWN';
  it.each<[Tri, Tri, Tri, Tri]>([
    [T, T, T, T],
    [T, F, F, T],
    [T, U, U, T],
    [F, F, F, F],
    [F, U, F, U],
    [U, U, U, U],
  ])('%s AND/OR %s', (a, b, and, or) => {
    expect(triAnd([a, b])).toBe(and);
    expect(triAnd([b, a])).toBe(and);
    expect(triOr([a, b])).toBe(or);
    expect(triOr([b, a])).toBe(or);
  });
  it('NOT', () => {
    expect([triNot('TRUE'), triNot('FALSE'), triNot('UNKNOWN')]).toEqual(['FALSE', 'TRUE', 'UNKNOWN']);
  });
});

describe('evaluateRule', () => {
  const rule: RuleNode = {
    operator: 'AND',
    conditions: [
      { type: 'required_activities_completed', value: true },
      { type: 'minimum_score', value: 70 },
    ],
  };

  it('completes when every condition is TRUE; trace is post-order with details', () => {
    const r = evaluateRule(rule, baseCtx({ bestResults: allDone() }));
    // (80×2 + 6×1) / (100×2 + 10×1) × 100 = 79.05；閱讀活動 score 為 null，不計入
    expect(r).toMatchObject({ result: true, value: 'TRUE', blockingReasons: [] });
    expect(r.trace.map((t) => t.path)).toEqual(['$.conditions[0]', '$.conditions[1]', '$']);
    expect(r.trace[1]).toMatchObject({ type: 'minimum_score', result: 'TRUE', detail: { actual: 79.05, required: 70 } });
  });

  it('not doing an activity is FALSE, not UNKNOWN; an unknown total score is reported as DATA_NOT_AVAILABLE', () => {
    const r = evaluateRule(rule, baseCtx({ bestResults: { [QUIZ]: { status: 'passed', score: 90 } } }));
    expect(r.value).toBe('FALSE');
    expect(r.trace[0]).toMatchObject({ result: 'FALSE', detail: { completed: 1, required: 3 } });
    expect(r.trace[1]!.result).toBe('UNKNOWN');
    expect(r.blockingReasons).toEqual([
      { code: 'REQUIRED_ACTIVITIES_INCOMPLETE', activity_id: null, actual: 1, required: 3 },
      { code: 'DATA_NOT_AVAILABLE', activity_id: READ },
    ]);
  });

  it('a low score blocks with MIN_SCORE_NOT_MET', () => {
    const r = evaluateRule(rule, baseCtx({ bestResults: { ...allDone(), [QUIZ]: { status: 'completed', score: 40 } } }));
    expect(r.result).toBe(false);
    expect(r.blockingReasons).toEqual([{ code: 'MIN_SCORE_NOT_MET', activity_id: null, actual: 40.95, required: 70 }]);
  });

  it('OR succeeds on any TRUE branch; NOT and negate invert', () => {
    const ctx = baseCtx({ bestResults: { [QUIZ]: { status: 'passed', score: 95 } } });
    const or: RuleNode = {
      operator: 'OR',
      conditions: [
        { type: 'required_activities_completed', value: true },
        { type: 'minimum_activity_score', activity_id: QUIZ, value: 90 },
      ],
    };
    expect(evaluateRule(or, ctx).result).toBe(true);
    expect(evaluateRule({ operator: 'NOT', conditions: [or] }, ctx).result).toBe(false);
    expect(evaluateRule({ type: 'minimum_activity_score', activity_id: QUIZ, value: 99, negate: true }, ctx).result).toBe(true);
    const negated = evaluateRule({ type: 'minimum_activity_score', activity_id: QUIZ, value: 90, negate: true }, ctx);
    expect(negated.blockingReasons).toEqual([{ code: 'NEGATED_CONDITION_MET', activity_id: QUIZ }]);
  });

  it.each<[string, RuleNode, Partial<CompletionContext>, Tri]>([
    ['specific activities', { type: 'specific_activities_completed', activity_ids: [QUIZ, VIDEO] }, { bestResults: { [QUIZ]: { status: 'passed', score: 1 } } }, 'FALSE'],
    ['activity score without a result', { type: 'minimum_activity_score', activity_id: QUIZ, value: 1 }, {}, 'FALSE'],
    ['video ratio met', { type: 'video_watch_ratio', activity_id: VIDEO, value: 0.8 }, { videoWatchRatios: { [VIDEO]: 0.9 } }, 'TRUE'],
    ['video ratio on a non-video activity', { type: 'video_watch_ratio', activity_id: QUIZ, value: 0.5 }, {}, 'UNKNOWN'],
    ['attempt passed', { type: 'attempt_status', activity_id: QUIZ, value: 'passed' }, { bestResults: { [QUIZ]: { status: 'completed', score: 50 } } }, 'FALSE'],
    ['attempt scored', { type: 'attempt_status', activity_id: QUIZ, value: 'scored' }, { bestResults: { [QUIZ]: { status: 'completed', score: 50 } } }, 'TRUE'],
    ['module completed', { type: 'module_completed', module_id: M2 }, { bestResults: { [VIDEO]: { status: 'completed', score: 3 } } }, 'TRUE'],
    ['lesson without required activities', { type: 'lesson_completed', lesson_id: 'nope' }, {}, 'UNKNOWN'],
    ['time on course', { type: 'time_spent_minimum', value: 30 }, { timeSpentMinutes: { course: 45, byModule: {} } }, 'TRUE'],
    ['time on a module', { type: 'time_spent_minimum', value: 30, scope: 'module', scope_id: M1 }, { timeSpentMinutes: { course: 99, byModule: { [M1]: 10 } } }, 'FALSE'],
    ['attempt count within limit', { type: 'attempt_count_maximum', activity_id: QUIZ, value: 2 }, { bestResults: { [QUIZ]: { status: 'passed', score: 1 } }, attemptCounts: { [QUIZ]: 2 } }, 'TRUE'],
    ['attempt count needs completion', { type: 'attempt_count_maximum', activity_id: QUIZ, value: 5 }, {}, 'FALSE'],
    ['manual approval', { type: 'manual_approval', approver_role: 'instructor' }, { manualApprovals: [{ approverRole: 'instructor', approvedAt: '2026-09-13T00:00:00Z' }] }, 'TRUE'],
  ])('%s', (_label, node, over, expected) => {
    expect(evaluateRule(node, baseCtx(over)).value).toBe(expected);
  });

  it('refuses rules nested deeper than 5 levels', () => {
    let node: RuleNode = { type: 'minimum_score', value: 1 };
    for (let i = 0; i < 5; i++) node = { operator: 'AND', conditions: [node] };
    expect(() => evaluateRule(node, baseCtx())).toThrow(RuleDepthExceededError);
  });
});

describe('validateRule (SD §3.6, C2)', () => {
  const codes = (rule: unknown, opts?: Parameters<typeof validateRule>[2]) => {
    const r = validateRule(rule, structure, opts);
    return { errors: r.errors.map((e) => `${e.code} ${e.path}`), warnings: r.warnings.map((w) => `${w.code} ${w.path}`) };
  };

  it('accepts a well-formed rule', () => {
    expect(
      codes({
        operator: 'AND',
        conditions: [
          { type: 'required_activities_completed', value: true },
          { operator: 'OR', conditions: [{ type: 'minimum_score', value: 70 }, { type: 'manual_approval', approver_role: 'instructor' }] },
          { type: 'video_watch_ratio', activity_id: VIDEO, value: 0.8, negate: false },
          { type: 'time_spent_minimum', value: 60, scope: 'module', scope_id: M1 },
        ],
      }),
    ).toEqual({ errors: [], warnings: [] });
  });

  it.each<[string, unknown, string[]]>([
    ['not an object', 'AND', ['RULE_SCHEMA_INVALID $']],
    ['unknown operator', { operator: 'XOR', conditions: [{ type: 'minimum_score', value: 1 }] }, ['RULE_SCHEMA_INVALID $.operator']],
    ['empty group', { operator: 'AND', conditions: [] }, ['RULE_SCHEMA_INVALID $.conditions']],
    ['NOT with two conditions', { operator: 'NOT', conditions: [{ type: 'minimum_score', value: 1 }, { type: 'minimum_score', value: 2 }] }, ['RULE_SCHEMA_INVALID $.conditions']],
    ['unknown type', { type: 'magic' }, ['RULE_SCHEMA_INVALID $.type']],
    ['typo field', { type: 'minimum_score', value: 50, valeu: 60 }, ['RULE_SCHEMA_INVALID $']],
    ['missing field', { type: 'minimum_activity_score', activity_id: QUIZ }, ['RULE_SCHEMA_INVALID $']],
    ['deleted activity', { type: 'specific_activities_completed', activity_ids: [QUIZ, GHOST] }, ['RULE_REFERENCE_NOT_FOUND $.activity_ids[1]']],
    ['unknown module', { type: 'module_completed', module_id: GHOST }, ['RULE_REFERENCE_NOT_FOUND $.module_id']],
    ['video ratio on a quiz', { type: 'video_watch_ratio', activity_id: QUIZ, value: 0.5 }, ['RULE_TYPE_MISMATCH $.activity_id']],
    ['score over 100', { type: 'minimum_score', value: 120 }, ['RULE_VALUE_OUT_OF_RANGE $.value']],
    ['ratio over 1', { type: 'video_watch_ratio', activity_id: VIDEO, value: 80 }, ['RULE_VALUE_OUT_OF_RANGE $.value']],
    ['activity score over its max', { type: 'minimum_activity_score', activity_id: VIDEO, value: 11 }, ['RULE_VALUE_OUT_OF_RANGE $.value']],
    ['scope_id without module scope', { type: 'time_spent_minimum', value: 5, scope_id: M1 }, ['RULE_SCHEMA_INVALID $.scope_id']],
    ['bad approver', { type: 'manual_approval', approver_role: 'learner' }, ['RULE_SCHEMA_INVALID $.approver_role']],
  ])('%s', (_label, rule, expected) => {
    expect(codes(rule).errors).toEqual(expected);
  });

  it('limits depth (5) and total conditions (50)', () => {
    let deep: unknown = { type: 'minimum_score', value: 1 };
    for (let i = 0; i < 5; i++) deep = { operator: 'AND', conditions: [deep] };
    expect(codes(deep).errors).toEqual(['RULE_DEPTH_EXCEEDED $.conditions[0].conditions[0].conditions[0].conditions[0].conditions[0]']);
    const wide = { operator: 'AND', conditions: Array.from({ length: 51 }, () => ({ type: 'minimum_score', value: 1 })) };
    expect(codes(wide).errors).toEqual(['RULE_TOO_COMPLEX $']);
  });

  it('warns about conditions that can never be satisfied', () => {
    expect(codes({ type: 'attempt_count_maximum', activity_id: QUIZ, value: 0 }).warnings).toEqual(['RULE_UNSATISFIABLE $.value']);
    // L2 只有影片（必修）與選修測驗；M2 有必修影片 → 不警告
    expect(codes({ type: 'module_completed', module_id: M2 }).warnings).toEqual([]);
    const noRequired = validateRule({ type: 'lesson_completed', lesson_id: L2 }, { ...structure, activities: { [OPTIONAL]: structure.activities[OPTIONAL]! } });
    expect(noRequired.warnings.map((w) => w.code)).toEqual(['RULE_UNSATISFIABLE']);
  });

  it('prerequisites accept only the per-activity subset (SD §3.7)', () => {
    const opts = { allowedTypes: ['specific_activities_completed', 'minimum_activity_score'] as const };
    expect(codes({ type: 'specific_activities_completed', activity_ids: [QUIZ] }, opts).errors).toEqual([]);
    expect(codes({ type: 'minimum_score', value: 60 }, opts).errors).toEqual(['RULE_SCHEMA_INVALID $.type']);
  });
});

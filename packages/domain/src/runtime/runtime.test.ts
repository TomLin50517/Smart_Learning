import { describe, expect, it } from 'vitest';
import type { CompletionContext } from '../completion/evaluate.js';
import { validateJsonSchema } from '../publish/json-schema-lite.js';
import {
  CHOICE_QUIZ_ANSWER_KEY_SCHEMA,
  CHOICE_QUIZ_CONFIG_SCHEMA,
  choiceQuizEvaluator,
  parameterRangeEvaluator,
  readingEvaluator,
  resolveEvaluator,
  sequenceOrderEvaluator,
  videoEvaluator,
} from './evaluators.js';
import { activityAvailability } from './unlock.js';

const QUIZ = {
  questions: [
    { id: 'q1', prompt: '1+1', options: [{ id: 'a', label: '1' }, { id: 'b', label: '2' }] },
    { id: 'q2', prompt: '偶數', multiple: true, options: [{ id: 'x', label: '2' }, { id: 'y', label: '3' }, { id: 'z', label: '4' }] },
  ],
};
const QUIZ_KEY = { correct: { q1: ['b'], q2: ['x', 'z'] }, pass_threshold: 100 };

describe('evaluators', () => {
  it('resolves by server evaluator first, then by activity type', () => {
    expect(resolveEvaluator('interactive', 'ParameterRangeEvaluator')).toBe(parameterRangeEvaluator);
    expect(resolveEvaluator('interactive', 'H5pXapiEvaluator')).toBeNull();
    expect(resolveEvaluator('quiz', null)).toBe(choiceQuizEvaluator);
    expect(resolveEvaluator('reading', null)).toBe(readingEvaluator);
    expect(resolveEvaluator('assignment', null)).toBeNull();
  });

  it('choice quiz: validates answers and scores without revealing the key', () => {
    expect(choiceQuizEvaluator.validateInput({ answers: { q9: ['a'] } }, QUIZ).map((p) => p.code)).toEqual(['UNKNOWN_QUESTION']);
    expect(choiceQuizEvaluator.validateInput({ answers: { q1: ['a', 'b'] } }, QUIZ).map((p) => p.code)).toEqual(['SINGLE_CHOICE']);
    expect(choiceQuizEvaluator.validateInput({ answers: { q1: ['c'] } }, QUIZ).map((p) => p.code)).toEqual(['UNKNOWN_OPTION']);

    const half = choiceQuizEvaluator.evaluate({ answers: { q1: ['b'], q2: ['x'] } }, { config: QUIZ, answerKey: QUIZ_KEY, maxScore: 10 });
    expect(half).toMatchObject({ status: 'failed', score: 5, issues: [{ code: 'WRONG_ANSWER', target: 'q2' }] });
    expect(JSON.stringify(half.feedbackData)).not.toContain('"z"');
    const full = choiceQuizEvaluator.evaluate({ answers: { q1: ['b'], q2: ['z', 'x'] } }, { config: QUIZ, answerKey: QUIZ_KEY, maxScore: 10 });
    expect(full).toMatchObject({ status: 'passed', score: 10, issues: [] });
    expect(choiceQuizEvaluator.evaluate({ answers: {} }, { config: QUIZ, answerKey: null, maxScore: 10 }).status).toBe('completed');
  });

  it('parameter ranges: in range scores, out of range reports the configured issue code', () => {
    const config = { parameters: [{ id: 't', label: '溫度', min: 0, max: 100, step: 1 }] };
    const key = { acceptable_ranges: [{ parameter_id: 't', min: 40, max: 60, issue_code_if_high: 'TEMP_HIGH' }] };
    expect(parameterRangeEvaluator.validateInput({ values: { t: 120 } }, config).map((p) => p.code)).toEqual(['OUT_OF_BOUNDS']);
    expect(parameterRangeEvaluator.validateInput({ values: {} }, config).map((p) => p.code)).toEqual(['MISSING_VALUE']);
    expect(parameterRangeEvaluator.evaluate({ values: { t: 80 } }, { config, answerKey: key, maxScore: 100 })).toMatchObject({
      status: 'needs_improvement',
      score: 0,
      issues: [{ code: 'TEMP_HIGH', category: 'parameter', target: 't' }],
    });
    expect(parameterRangeEvaluator.evaluate({ values: { t: 10 } }, { config, answerKey: key, maxScore: 100 }).issues[0]!.code).toBe('VALUE_TOO_LOW');
    expect(parameterRangeEvaluator.evaluate({ values: { t: 50 } }, { config, answerKey: key, maxScore: 100 })).toMatchObject({ status: 'passed', score: 100 });
  });

  it('sequence order: exact, partial credit and tolerance', () => {
    const config = { steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };
    expect(sequenceOrderEvaluator.validateInput({ order: ['a', 'b', 'c'] }, config).map((p) => p.code)).toEqual(['NOT_A_PERMUTATION']);
    const key = { correct_order: ['a', 'b', 'c', 'd'] };
    expect(sequenceOrderEvaluator.evaluate({ order: ['a', 'b', 'c', 'd'] }, { config, answerKey: key, maxScore: 10 })).toMatchObject({ status: 'passed', score: 10 });
    expect(sequenceOrderEvaluator.evaluate({ order: ['b', 'a', 'c', 'd'] }, { config, answerKey: key, maxScore: 10 })).toMatchObject({ status: 'needs_improvement', score: 0 });
    expect(sequenceOrderEvaluator.evaluate({ order: ['b', 'a', 'c', 'd'] }, { config, answerKey: { ...key, partial_credit: true }, maxScore: 10 }).score).toBe(5);
    const timeline = { events: config.steps };
    expect(sequenceOrderEvaluator.evaluate({ order: ['b', 'a', 'c', 'd'] }, { config: timeline, answerKey: { ...key, tolerance: 1 }, maxScore: 10 }).score).toBe(10);
  });

  it('video needs the required watch ratio; reading completes on submit', () => {
    expect(videoEvaluator.validateInput({ watchedRatio: 2 }, {}).map((p) => p.code)).toEqual(['INVALID_RATIO']);
    expect(videoEvaluator.evaluate({ watchedRatio: 0.5 }, { config: {}, answerKey: null, maxScore: 1 }).status).toBe('needs_improvement');
    expect(videoEvaluator.evaluate({ watchedRatio: 0.95 }, { config: {}, answerKey: null, maxScore: 1 }).status).toBe('completed');
    expect(readingEvaluator.evaluate({}, { config: {}, answerKey: null, maxScore: 1 })).toMatchObject({ status: 'completed', score: null });
  });

  it('the built-in quiz schemas accept a valid quiz and reject a malformed one (C5)', () => {
    expect(validateJsonSchema(CHOICE_QUIZ_CONFIG_SCHEMA, QUIZ).violations).toEqual([]);
    expect(validateJsonSchema(CHOICE_QUIZ_ANSWER_KEY_SCHEMA, QUIZ_KEY).violations).toEqual([]);
    expect(validateJsonSchema(CHOICE_QUIZ_CONFIG_SCHEMA, { questions: [{ id: 'q', prompt: 'x', options: [{ id: 'a', label: 'a' }] }] }).violations.map((v) => v.path)).toEqual([
      '/questions/0/options',
    ]);
  });
});

describe('activityAvailability', () => {
  const ctx = (done: string[]): CompletionContext => ({
    requiredActivityIds: ['A', 'B', 'C'],
    activities: {
      A: { weight: 1, maxScore: 100, moduleId: 'M1', lessonId: 'L1', activityType: 'reading' },
      B: { weight: 1, maxScore: 100, moduleId: 'M1', lessonId: 'L1', activityType: 'quiz' },
      C: { weight: 1, maxScore: 100, moduleId: 'M2', lessonId: 'L2', activityType: 'quiz' },
    },
    bestResults: Object.fromEntries(done.map((id) => [id, { status: 'completed', score: null }])),
    attemptCounts: {},
    videoWatchRatios: {},
    timeSpentMinutes: { course: 0, byModule: {} },
    manualApprovals: [],
  });
  const structure = (mode: 'strict' | 'mixed' | 'free', bPrereq: boolean) => ({
    navigationMode: mode,
    modules: [
      { id: 'M1', activities: [{ id: 'A', prerequisite: null }, { id: 'B', prerequisite: bPrereq ? { type: 'specific_activities_completed' as const, activity_ids: ['A'] } : null }] },
      { id: 'M2', activities: [{ id: 'C', prerequisite: null }] },
    ],
  });
  const unlocked = (r: ReturnType<typeof activityAvailability>) => Object.entries(r).filter(([, v]) => v.unlocked).map(([k]) => k);

  it('mixed: the next module opens after the previous one; explicit prerequisites apply', () => {
    const r = activityAvailability(structure('mixed', true), ctx([]));
    expect(unlocked(r)).toEqual(['A']);
    expect(r.B).toEqual({ unlocked: false, reason: 'prerequisite' });
    expect(r.C).toEqual({ unlocked: false, reason: 'sequence' });
    expect(unlocked(activityAvailability(structure('mixed', true), ctx(['A', 'B'])))).toEqual(['A', 'B', 'C']);
  });

  it('strict follows the order; free opens everything without prerequisites', () => {
    expect(unlocked(activityAvailability(structure('strict', false), ctx(['A'])))).toEqual(['A', 'B']);
    expect(unlocked(activityAvailability(structure('free', false), ctx([])))).toEqual(['A', 'B', 'C']);
  });
});

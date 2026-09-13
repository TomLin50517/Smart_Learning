import type { ResultIssue, ResultStatus } from '@iac/contracts';

/**
 * 伺服器端評分器（ADR-024、SA INV-3／INV-4）。純函式、無 LLM：成績只由此產生，
 * 前端只送原始作答（AC-LRN-003）。每個評分器先驗證輸入格式，再依 answerKey 評分。
 */
export interface EvaluationContext {
  config: Record<string, unknown>;
  answerKey: Record<string, unknown> | null;
  maxScore: number;
}

export interface EvaluatorOutput {
  status: ResultStatus;
  score: number | null;
  issues: ResultIssue[];
  feedbackData: Record<string, unknown>;
}

export interface InputProblem {
  field?: string;
  code: string;
  message: string;
}

export interface ActivityEvaluator {
  readonly name: string;
  readonly version: string;
  /** 空陣列＝輸入合法 */
  validateInput(input: unknown, config: Record<string, unknown>): InputProblem[];
  evaluate(input: unknown, ctx: EvaluationContext): EvaluatorOutput;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round2 = (n: number) => Math.round(n * 100) / 100;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 閱讀：送出即完成（不計分） */
export const readingEvaluator: ActivityEvaluator = {
  name: 'ReadingCompletionEvaluator',
  version: '1.0',
  validateInput: (input) => (isObj(input) ? [] : [{ code: 'INPUT_NOT_OBJECT', message: '輸入必須是物件' }]),
  evaluate: () => ({ status: 'completed', score: null, issues: [], feedbackData: {} }),
};

/** 影片：觀看比例達 config.completion_ratio（預設 0.9）才算完成（不計分） */
export const videoEvaluator: ActivityEvaluator = {
  name: 'VideoWatchEvaluator',
  version: '1.0',
  validateInput: (input) => {
    if (!isObj(input) || !isNum(input.watchedRatio) || input.watchedRatio < 0 || input.watchedRatio > 1) {
      return [{ field: 'watchedRatio', code: 'INVALID_RATIO', message: '觀看比例必須介於 0 到 1' }];
    }
    return [];
  },
  evaluate: (input, { config }) => {
    const ratio = (input as { watchedRatio: number }).watchedRatio;
    const threshold = isNum(config.completion_ratio) ? config.completion_ratio : 0.9;
    const done = ratio >= threshold;
    return {
      status: done ? 'completed' : 'needs_improvement',
      score: null,
      issues: done ? [] : [{ code: 'VIDEO_NOT_FINISHED', category: 'video', severity: 'low' }],
      feedbackData: { watchedRatio: ratio, requiredRatio: threshold },
    };
  },
};

interface QuizQuestion {
  id: string;
  multiple: boolean;
  options: Set<string>;
}
function quizQuestions(config: Obj): QuizQuestion[] {
  return arr(config.questions).filter(isObj).map((q) => ({
    id: String(q.id),
    multiple: q.multiple === true,
    options: new Set(arr(q.options).filter(isObj).map((o) => String(o.id))),
  }));
}

/** 原生選擇題（activityType 'quiz'、無互動元件）：依答對題數給分 */
export const choiceQuizEvaluator: ActivityEvaluator = {
  name: 'ChoiceQuizEvaluator',
  version: '1.0',
  validateInput: (input, config) => {
    if (!isObj(input) || !isObj(input.answers)) return [{ field: 'answers', code: 'INPUT_NOT_OBJECT', message: 'answers 必須是物件' }];
    const questions = new Map(quizQuestions(config).map((q) => [q.id, q]));
    const problems: InputProblem[] = [];
    for (const [qid, picked] of Object.entries(input.answers)) {
      const q = questions.get(qid);
      if (!q) problems.push({ field: `answers.${qid}`, code: 'UNKNOWN_QUESTION', message: '沒有這一題' });
      else if (!Array.isArray(picked) || picked.some((x) => typeof x !== 'string' || !q.options.has(x))) {
        problems.push({ field: `answers.${qid}`, code: 'UNKNOWN_OPTION', message: '選項不存在' });
      } else if (new Set(picked).size !== picked.length) problems.push({ field: `answers.${qid}`, code: 'DUPLICATE_OPTION', message: '選項重複' });
      else if (!q.multiple && picked.length > 1) problems.push({ field: `answers.${qid}`, code: 'SINGLE_CHOICE', message: '這一題只能選一個' });
    }
    return problems;
  },
  evaluate: (input, { config, answerKey, maxScore }) => {
    const answers = (input as { answers: Record<string, string[]> }).answers;
    const correct = isObj(answerKey) && isObj(answerKey.correct) ? (answerKey.correct as Record<string, unknown>) : null;
    const questions = quizQuestions(config);
    // 沒有正解：當作問卷，完成即可
    if (!correct) return { status: 'completed', score: null, issues: [], feedbackData: { answered: Object.keys(answers).length } };

    const scored = questions.filter((q) => Array.isArray(correct[q.id]));
    const perQuestion: Record<string, boolean> = {};
    const issues: ResultIssue[] = [];
    for (const q of scored) {
      const picked = answers[q.id] ?? [];
      const expected = new Set((correct[q.id] as unknown[]).map(String));
      const ok = picked.length === expected.size && picked.every((x) => expected.has(x));
      perQuestion[q.id] = ok;
      if (!ok) issues.push({ code: picked.length ? 'WRONG_ANSWER' : 'UNANSWERED', category: 'question', severity: 'medium', target: q.id });
    }
    const correctCount = Object.values(perQuestion).filter(Boolean).length;
    const total = scored.length;
    if (total === 0) return { status: 'completed', score: null, issues: [], feedbackData: {} };
    const pct = (correctCount / total) * 100;
    const threshold = isNum(answerKey!.pass_threshold) ? answerKey!.pass_threshold : 60;
    return {
      status: pct >= threshold ? 'passed' : 'failed',
      score: round2((correctCount / total) * maxScore),
      issues,
      // 只回報對錯，不回報正解
      feedbackData: { correctCount, total, perQuestion },
    };
  },
};

/** native.ParameterControl：數值落在可接受範圍即得分（pass_threshold 為得分比例 %，預設 100） */
export const parameterRangeEvaluator: ActivityEvaluator = {
  name: 'ParameterRangeEvaluator',
  version: '1.0',
  validateInput: (input, config) => {
    if (!isObj(input) || !isObj(input.values)) return [{ field: 'values', code: 'INPUT_NOT_OBJECT', message: 'values 必須是物件' }];
    const params = arr(config.parameters).filter(isObj);
    const known = new Set(params.map((p) => String(p.id)));
    const problems: InputProblem[] = [];
    for (const k of Object.keys(input.values)) if (!known.has(k)) problems.push({ field: `values.${k}`, code: 'UNKNOWN_PARAMETER', message: '沒有這個參數' });
    for (const p of params) {
      const v = input.values[String(p.id)];
      if (!isNum(v)) problems.push({ field: `values.${String(p.id)}`, code: 'MISSING_VALUE', message: '缺少數值' });
      else if ((isNum(p.min) && v < p.min) || (isNum(p.max) && v > p.max)) {
        problems.push({ field: `values.${String(p.id)}`, code: 'OUT_OF_BOUNDS', message: '超出可調整的範圍' });
      }
    }
    return problems;
  },
  evaluate: (input, { answerKey, maxScore }) => {
    const values = (input as { values: Record<string, number> }).values;
    const ranges = arr(isObj(answerKey) ? answerKey.acceptable_ranges : undefined).filter(isObj);
    if (!ranges.length) return { status: 'completed', score: null, issues: [], feedbackData: { values } };
    const scoring = isObj(answerKey!.scoring) ? answerKey!.scoring : {};
    const points = isNum(scoring.per_parameter_points) ? scoring.per_parameter_points : 1;
    const threshold = isNum(scoring.pass_threshold) ? scoring.pass_threshold : 100;
    const issues: ResultIssue[] = [];
    const inRange: Record<string, boolean> = {};
    let earned = 0;
    for (const r of ranges) {
      const pid = String(r.parameter_id);
      const v = values[pid];
      const ok = isNum(v) && isNum(r.min) && isNum(r.max) && v >= r.min && v <= r.max;
      inRange[pid] = ok;
      if (ok) earned += points;
      else {
        const high = isNum(v) && isNum(r.max) && v > r.max;
        const code = high ? (typeof r.issue_code_if_high === 'string' ? r.issue_code_if_high : 'VALUE_TOO_HIGH') : typeof r.issue_code_if_low === 'string' ? r.issue_code_if_low : 'VALUE_TOO_LOW';
        issues.push({ code, category: 'parameter', severity: 'medium', target: pid });
      }
    }
    const total = points * ranges.length;
    const pct = total > 0 ? (earned / total) * 100 : 0;
    return {
      status: pct >= threshold ? 'passed' : 'needs_improvement',
      score: round2(total > 0 ? (earned / total) * maxScore : 0),
      issues,
      feedbackData: { values, inRange },
    };
  },
};

const sequenceItems = (config: Obj) =>
  arr(config.steps ?? config.events)
    .filter(isObj)
    .map((x) => String(x.id));

/** native.StepSequence／Timeline：與 correct_order 比對（partial_credit 依位置給分；tolerance 容許的位置誤差） */
export const sequenceOrderEvaluator: ActivityEvaluator = {
  name: 'SequenceOrderEvaluator',
  version: '1.0',
  validateInput: (input, config) => {
    const items = sequenceItems(config);
    if (!isObj(input) || !Array.isArray(input.order)) return [{ field: 'order', code: 'INPUT_NOT_ARRAY', message: 'order 必須是陣列' }];
    const order = input.order;
    const ok = order.length === items.length && new Set(order).size === order.length && order.every((x) => typeof x === 'string' && items.includes(x));
    return ok ? [] : [{ field: 'order', code: 'NOT_A_PERMUTATION', message: '必須把每個項目各排一次' }];
  },
  evaluate: (input, { answerKey, maxScore }) => {
    const order = (input as { order: string[] }).order;
    const correct = arr(isObj(answerKey) ? answerKey.correct_order : undefined).map(String);
    if (!correct.length) return { status: 'completed', score: null, issues: [], feedbackData: { order } };
    const tolerance = isObj(answerKey) && isNum(answerKey.tolerance) && answerKey.tolerance >= 0 ? answerKey.tolerance : 0;
    const partial = (isObj(answerKey) && answerKey.partial_credit === true) || tolerance > 0;
    const issues: ResultIssue[] = [];
    let correctPositions = 0;
    order.forEach((item, i) => {
      const expected = correct.indexOf(item);
      if (expected >= 0 && Math.abs(expected - i) <= tolerance) correctPositions++;
      else issues.push({ code: 'OUT_OF_ORDER', category: 'sequence', severity: 'low', target: item });
    });
    const exact = correctPositions === order.length;
    return {
      status: exact ? 'passed' : 'needs_improvement',
      score: round2(exact ? maxScore : partial ? (correctPositions / order.length) * maxScore : 0),
      issues,
      feedbackData: { correctPositions, total: order.length },
    };
  },
};

const BY_SERVER_EVALUATOR: Record<string, ActivityEvaluator> = {
  ParameterRangeEvaluator: parameterRangeEvaluator,
  SequenceOrderEvaluator: sequenceOrderEvaluator,
};

/**
 * 找出活動的評分器：有互動元件時依元件的 server_evaluator；否則依活動類型的內建評分器。
 * 找不到（H5P、作業等尚未支援的類型）回 null，Runtime 會標示 supported: false。
 */
export function resolveEvaluator(activityType: string, serverEvaluator: string | null): ActivityEvaluator | null {
  if (serverEvaluator) return BY_SERVER_EVALUATOR[serverEvaluator] ?? null;
  switch (activityType) {
    case 'reading':
      return readingEvaluator;
    case 'video':
      return videoEvaluator;
    case 'quiz':
      return choiceQuizEvaluator;
    default:
      return null;
  }
}

/** 原生選擇題的 schema（發布前 C5 檢查；json-schema-lite 支援的關鍵字） */
export const CHOICE_QUIZ_CONFIG_SCHEMA = {
  type: 'object',
  required: ['questions'],
  additionalProperties: false,
  properties: {
    instructions: { type: 'string' },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['id', 'prompt', 'options'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          prompt: { type: 'string', minLength: 1 },
          multiple: { type: 'boolean' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 10,
            items: {
              type: 'object',
              required: ['id', 'label'],
              additionalProperties: false,
              properties: { id: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
    },
  },
} as const;

export const CHOICE_QUIZ_ANSWER_KEY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    correct: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    pass_threshold: { type: 'number', minimum: 0, maximum: 100 },
  },
} as const;

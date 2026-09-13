import {
  APPROVER_ROLES,
  ATTEMPT_STATUS_TARGETS,
  RULE_CONDITION_TYPES,
  RULE_LIMITS,
  RULE_OPERATORS,
  type RuleConditionType,
  type RuleIssueCode,
  type ValidationIssueDto,
} from '@iac/contracts';

/** 規則引用的課程結構：只取驗證需要的欄位 */
export interface RuleStructure {
  activities: Record<string, { activityType: string; moduleId: string; lessonId: string; isRequired: boolean; maxScore: number }>;
  moduleIds: readonly string[];
  lessonIds: readonly string[];
}

export interface RuleValidation {
  errors: ValidationIssueDto[];
  warnings: ValidationIssueDto[];
}

/** 每種條件的欄位（type、negate 以外）。多出的欄位視為錯誤——打錯字的欄位不能被默默忽略 */
const FIELDS: Record<RuleConditionType, { req: readonly string[]; opt: readonly string[] }> = {
  required_activities_completed: { req: ['value'], opt: [] },
  specific_activities_completed: { req: ['activity_ids'], opt: [] },
  minimum_score: { req: ['value'], opt: [] },
  minimum_activity_score: { req: ['activity_id', 'value'], opt: [] },
  video_watch_ratio: { req: ['activity_id', 'value'], opt: [] },
  attempt_status: { req: ['activity_id', 'value'], opt: [] },
  module_completed: { req: ['module_id'], opt: [] },
  lesson_completed: { req: ['lesson_id'], opt: [] },
  time_spent_minimum: { req: ['value'], opt: ['scope', 'scope_id'] },
  attempt_count_maximum: { req: ['activity_id', 'value'], opt: [] },
  manual_approval: { req: ['approver_role'], opt: [] },
};

const MAX_MINUTES = 100_000;
const MAX_ACTIVITY_IDS = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 完成條件／先修條件的驗證器（SD §3.6，發布前 C2 與儲存時共用）。純函式。
 * 輸入是未經型別保證的 JSON；回傳所有問題而非遇錯即停，讓編輯者一次看到全部。
 * `allowedTypes` 用於先修條件（SD §3.7 的子集）。
 */
export function validateRule(rule: unknown, s: RuleStructure, opts: { allowedTypes?: readonly RuleConditionType[] } = {}): RuleValidation {
  const out: RuleValidation = { errors: [], warnings: [] };
  const issue = (list: ValidationIssueDto[]) => (code: RuleIssueCode, path: string, message: string, targetId?: string) =>
    void list.push({ code, path, message, ...(targetId !== undefined && { targetId }) });
  const err = issue(out.errors);
  const warn = issue(out.warnings);
  const modules = new Set(s.moduleIds);
  const lessons = new Set(s.lessonIds);
  let conditions = 0;
  let depthReported = false;

  const activityRef = (id: unknown, path: string) => {
    if (typeof id !== 'string' || !id) {
      err('RULE_SCHEMA_INVALID', path, '必須指定活動');
      return null;
    }
    const a = s.activities[id];
    if (!a) err('RULE_REFERENCE_NOT_FOUND', path, '引用的活動不在此版本中', id);
    return a ?? null;
  };

  const requiredIn = (pick: (a: RuleStructure['activities'][string]) => boolean) => Object.values(s.activities).some((a) => a.isRequired && pick(a));

  const checkCondition = (c: Obj, type: RuleConditionType, path: string) => {
    switch (type) {
      case 'required_activities_completed':
        if (typeof c.value !== 'boolean') err('RULE_SCHEMA_INVALID', `${path}.value`, 'value 必須是布林值');
        return;
      case 'specific_activities_completed': {
        const ids = c.activity_ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ACTIVITY_IDS) {
          err('RULE_SCHEMA_INVALID', `${path}.activity_ids`, `至少指定一個、最多 ${MAX_ACTIVITY_IDS} 個活動`);
          return;
        }
        if (new Set(ids).size !== ids.length) err('RULE_SCHEMA_INVALID', `${path}.activity_ids`, '活動不可重複');
        ids.forEach((id, i) => activityRef(id, `${path}.activity_ids[${i}]`));
        return;
      }
      case 'minimum_score':
        if (!isNum(c.value)) err('RULE_SCHEMA_INVALID', `${path}.value`, '分數必須是數字');
        else if (c.value < 0 || c.value > 100) err('RULE_VALUE_OUT_OF_RANGE', `${path}.value`, '總分門檻須介於 0 到 100');
        return;
      case 'minimum_activity_score': {
        const a = activityRef(c.activity_id, `${path}.activity_id`);
        if (!isNum(c.value)) err('RULE_SCHEMA_INVALID', `${path}.value`, '分數必須是數字');
        else if (c.value < 0 || (a && c.value > a.maxScore)) err('RULE_VALUE_OUT_OF_RANGE', `${path}.value`, `分數門檻須介於 0 到活動滿分${a ? `（${a.maxScore}）` : ''}`);
        return;
      }
      case 'video_watch_ratio': {
        const a = activityRef(c.activity_id, `${path}.activity_id`);
        if (a && a.activityType !== 'video') err('RULE_TYPE_MISMATCH', `${path}.activity_id`, '觀看比例只能用於影片活動', String(c.activity_id));
        if (!isNum(c.value)) err('RULE_SCHEMA_INVALID', `${path}.value`, '比例必須是數字');
        else if (c.value < 0 || c.value > 1) err('RULE_VALUE_OUT_OF_RANGE', `${path}.value`, '觀看比例須介於 0 到 1');
        return;
      }
      case 'attempt_status':
        activityRef(c.activity_id, `${path}.activity_id`);
        if (!ATTEMPT_STATUS_TARGETS.includes(c.value as never)) err('RULE_SCHEMA_INVALID', `${path}.value`, '作答狀態必須是 passed、completed 或 scored');
        return;
      case 'module_completed': {
        const id = c.module_id;
        if (typeof id !== 'string' || !modules.has(id)) err('RULE_REFERENCE_NOT_FOUND', `${path}.module_id`, '引用的單元不在此版本中', typeof id === 'string' ? id : undefined);
        else if (!requiredIn((a) => a.moduleId === id)) warn('RULE_UNSATISFIABLE', `${path}.module_id`, '此單元沒有必修活動，條件永遠無法成立', id);
        return;
      }
      case 'lesson_completed': {
        const id = c.lesson_id;
        if (typeof id !== 'string' || !lessons.has(id)) err('RULE_REFERENCE_NOT_FOUND', `${path}.lesson_id`, '引用的課節不在此版本中', typeof id === 'string' ? id : undefined);
        else if (!requiredIn((a) => a.lessonId === id)) warn('RULE_UNSATISFIABLE', `${path}.lesson_id`, '此課節沒有必修活動，條件永遠無法成立', id);
        return;
      }
      case 'time_spent_minimum': {
        if (!isNum(c.value)) err('RULE_SCHEMA_INVALID', `${path}.value`, '分鐘數必須是數字');
        else if (c.value < 0 || c.value > MAX_MINUTES) err('RULE_VALUE_OUT_OF_RANGE', `${path}.value`, `分鐘數須介於 0 到 ${MAX_MINUTES}`);
        if (c.scope !== undefined && c.scope !== 'course' && c.scope !== 'module') err('RULE_SCHEMA_INVALID', `${path}.scope`, '範圍必須是 course 或 module');
        if (c.scope === 'module') {
          const id = c.scope_id;
          if (typeof id !== 'string' || !modules.has(id)) err('RULE_REFERENCE_NOT_FOUND', `${path}.scope_id`, '引用的單元不在此版本中', typeof id === 'string' ? id : undefined);
        } else if (c.scope_id !== undefined) {
          err('RULE_SCHEMA_INVALID', `${path}.scope_id`, '只有 scope 為 module 時才能指定 scope_id');
        }
        return;
      }
      case 'attempt_count_maximum':
        activityRef(c.activity_id, `${path}.activity_id`);
        if (!Number.isInteger(c.value) || (c.value as number) < 0) err('RULE_SCHEMA_INVALID', `${path}.value`, '次數必須是 0 以上的整數');
        else if (c.value === 0) warn('RULE_UNSATISFIABLE', `${path}.value`, '作答次數上限為 0：活動必須完成才成立，因此永遠無法成立');
        return;
      case 'manual_approval':
        if (!APPROVER_ROLES.includes(c.approver_role as never)) err('RULE_SCHEMA_INVALID', `${path}.approver_role`, '核可者角色必須是 instructor、course_admin 或 org_admin');
        return;
    }
  };

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > RULE_LIMITS.maxDepth) {
      if (!depthReported) err('RULE_DEPTH_EXCEEDED', path, `巢狀不可超過 ${RULE_LIMITS.maxDepth} 層`);
      depthReported = true;
      return;
    }
    if (!isObj(node)) return err('RULE_SCHEMA_INVALID', path, '條件必須是物件');

    if ('operator' in node || 'conditions' in node) {
      const extra = Object.keys(node).filter((k) => k !== 'operator' && k !== 'conditions');
      if (extra.length) err('RULE_SCHEMA_INVALID', path, `群組不支援的欄位：${extra.join('、')}`);
      if (!RULE_OPERATORS.includes(node.operator as never)) err('RULE_SCHEMA_INVALID', `${path}.operator`, '運算子必須是 AND、OR 或 NOT');
      const list = node.conditions;
      if (!Array.isArray(list) || list.length === 0) return err('RULE_SCHEMA_INVALID', `${path}.conditions`, '群組至少要有一個條件');
      if (node.operator === 'NOT' && list.length !== 1) err('RULE_SCHEMA_INVALID', `${path}.conditions`, 'NOT 群組只能包含一個條件');
      list.forEach((child, i) => walk(child, `${path}.conditions[${i}]`, depth + 1));
      return;
    }

    conditions++;
    if (!RULE_CONDITION_TYPES.includes(node.type as never)) return err('RULE_SCHEMA_INVALID', `${path}.type`, '不支援的條件類型');
    const type = node.type as RuleConditionType;
    if (opts.allowedTypes && !opts.allowedTypes.includes(type)) return err('RULE_SCHEMA_INVALID', `${path}.type`, '先修條件不支援此條件類型');
    const spec = FIELDS[type];
    const extra = Object.keys(node).filter((k) => k !== 'type' && k !== 'negate' && !spec.req.includes(k) && !spec.opt.includes(k));
    if (extra.length) err('RULE_SCHEMA_INVALID', path, `不支援的欄位：${extra.join('、')}`);
    const missing = spec.req.filter((k) => node[k] === undefined);
    if (missing.length) return err('RULE_SCHEMA_INVALID', path, `缺少欄位：${missing.join('、')}`);
    if (node.negate !== undefined && typeof node.negate !== 'boolean') err('RULE_SCHEMA_INVALID', `${path}.negate`, 'negate 必須是布林值');
    checkCondition(node, type, path);
  };

  walk(rule, '$', 1);
  if (conditions > RULE_LIMITS.maxConditions) err('RULE_TOO_COMPLEX', '$', `條件總數 ${conditions} 超過上限 ${RULE_LIMITS.maxConditions}`);
  return out;
}

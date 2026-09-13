import {
  APPROVER_ROLES,
  ATTEMPT_STATUS_TARGETS,
  COACH_KNOWLEDGE_SCOPES,
  COACH_LANGUAGES,
  COACH_POLICY_LIMITS,
  COACH_RESPONSE_MODES,
  COACH_TONE_PROFILES,
  RULE_CONDITION_TYPES,
  RULE_LIMITS,
  RULE_OPERATORS,
  type AttemptStatusTarget,
  type CoachPolicyDto,
  type CourseVersionDetailDto,
  type ModuleDto,
  type RuleCondition,
  type RuleConditionType,
  type RuleGroup,
  type RuleNode,
  type RuleOperator,
  type ValidationIssueDto,
} from '@iac/contracts';
import { useState } from 'react';
import { api } from '../api/client';
import { humanizeRulePath } from '../api/errors';
import { ErrorAlert, Field, Notice } from '../components/ui';
import {
  ATTEMPT_STATUS_TARGET_LABELS,
  COACH_KNOWLEDGE_SCOPE_LABELS,
  COACH_LANGUAGE_LABELS,
  COACH_RESPONSE_MODE_LABELS,
  COACH_TONE_LABELS,
  ROLE_LABELS,
  RULE_CONDITION_LABELS,
  RULE_OPERATOR_LABELS,
} from '../format';

// ======================================================================= 完成條件

const isGroup = (n: RuleNode): n is RuleGroup => 'operator' in n;

interface Option {
  id: string;
  label: string;
  activityType?: string;
}

/** 可引用的項目（以「已儲存」的結構為準）：「1-2 標題」的編號與編輯器一致 */
function referenceOptions(modules: ModuleDto[]) {
  const mods: Option[] = modules.map((m, mi) => ({ id: m.id, label: `第 ${mi + 1} 單元 ${m.title}` }));
  const lessons: Option[] = modules.flatMap((m, mi) => m.lessons.map((l, li) => ({ id: l.id, label: `${mi + 1}-${li + 1} ${l.title}` })));
  const acts: Option[] = modules.flatMap((m, mi) =>
    m.lessons.flatMap((l, li) => l.activities.map((a, ai) => ({ id: a.id, label: `${mi + 1}-${li + 1}-${ai + 1} ${a.title}`, activityType: a.activityType }))),
  );
  return { mods, lessons, acts };
}
type Refs = ReturnType<typeof referenceOptions>;

function defaultCondition(type: RuleConditionType, refs: Refs): RuleCondition {
  const act = refs.acts[0]?.id ?? '';
  switch (type) {
    case 'required_activities_completed':
      return { type, value: true };
    case 'specific_activities_completed':
      return { type, activity_ids: act ? [act] : [] };
    case 'minimum_score':
      return { type, value: 60 };
    case 'minimum_activity_score':
      return { type, activity_id: act, value: 60 };
    case 'video_watch_ratio':
      return { type, activity_id: refs.acts.find((a) => a.activityType === 'video')?.id ?? act, value: 0.8 };
    case 'attempt_status':
      return { type, activity_id: act, value: 'passed' };
    case 'module_completed':
      return { type, module_id: refs.mods[0]?.id ?? '' };
    case 'lesson_completed':
      return { type, lesson_id: refs.lessons[0]?.id ?? '' };
    case 'time_spent_minimum':
      return { type, value: 30 };
    case 'attempt_count_maximum':
      return { type, activity_id: act, value: 3 };
    case 'manual_approval':
      return { type, approver_role: 'instructor' };
  }
}

/** 版本編輯頁的「完成條件」卡片：自己的儲存按鈕（PUT completion-rules），與課程結構分開 */
export function CompletionRulesCard(props: { version: CourseVersionDetailDto; editable: boolean; structureDirty: boolean }) {
  const refs = referenceOptions(props.version.modules);
  const initial = props.version.completionRuleSet?.rule ?? null;
  // 根節點一律以群組編輯；單一條件的規則包成「全部符合」
  const [rule, setRule] = useState<RuleGroup | null>(initial ? (isGroup(initial) ? initial : { operator: 'AND', conditions: [initial] }) : null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [warnings, setWarnings] = useState<ValidationIssueDto[]>([]);
  const [saved, setSaved] = useState(false);

  const change = (next: RuleGroup | null) => {
    setRule(next);
    setDirty(true);
    setSaved(false);
  };

  async function save(next: RuleGroup | null) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ warnings: ValidationIssueDto[] }>('PUT', `/api/course-versions/${props.version.id}/completion-rules`, { rule: next });
      setWarnings(r.warnings);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="row structure-head">
        <h2 className="grow">完成條件</h2>
        {props.editable && dirty && <span className="badge badge-grace">尚未儲存</span>}
        {props.editable && (
          <button type="button" className="btn btn-primary" onClick={() => void save(rule)} disabled={busy || !dirty}>
            {busy ? '儲存中…' : '儲存完成條件'}
          </button>
        )}
      </div>
      <p className="muted small">學員符合以下條件才算完成課程。條件引用的活動以「已儲存」的課程結構為準。</p>
      {props.editable && props.structureDirty && <Notice kind="warn">課程結構有尚未儲存的變更；新增的活動要先儲存結構，才能在這裡選用。</Notice>}
      {saved && <Notice kind="ok">完成條件已儲存。</Notice>}
      {warnings.length > 0 && (
        <Notice kind="warn">
          儲存成功，但有以下提醒：
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>
                {humanizeRulePath(w.path)}：{w.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <ErrorAlert error={error} />

      {rule === null ? (
        <>
          <p className="muted">尚未設定完成條件（發布前必須設定）。</p>
          {props.editable && (
            <button type="button" className="btn" onClick={() => change({ operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }] })}>
              建立：完成所有必修活動
            </button>
          )}
        </>
      ) : (
        <fieldset disabled={!props.editable || busy} className="editor-root">
          <GroupEditor group={rule} depth={1} refs={refs} onChange={(g) => change(g)} />
          {props.editable && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => window.confirm('清除全部完成條件？') && (change(null), void save(null))}
            >
              清除完成條件
            </button>
          )}
        </fieldset>
      )}
    </section>
  );
}

function GroupEditor(props: { group: RuleGroup; depth: number; refs: Refs; onChange(g: RuleGroup): void; onRemove?: () => void }) {
  const { group, depth, refs } = props;
  const set = (fn: (g: RuleGroup) => void) => {
    const g = structuredClone(group);
    fn(g);
    props.onChange(g);
  };
  const setOperator = (op: RuleOperator) =>
    set((g) => {
      g.operator = op;
      // NOT 只能包含一個條件：原有多個條件時先包成「全部符合」
      if (op === 'NOT' && g.conditions.length > 1) g.conditions = [{ operator: 'AND', conditions: g.conditions }];
    });
  const canNest = depth < RULE_LIMITS.maxDepth - 1;
  const full = group.operator === 'NOT' && group.conditions.length >= 1;

  return (
    <div className="rule-group">
      <div className="row">
        <select value={group.operator} onChange={(e) => setOperator(e.target.value as RuleOperator)} aria-label="群組運算方式">
          {RULE_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {RULE_OPERATOR_LABELS[op]}
            </option>
          ))}
        </select>
        <span className="muted small">以下條件</span>
        {props.onRemove && (
          <button type="button" className="btn btn-small btn-ghost" onClick={props.onRemove}>
            移除群組
          </button>
        )}
      </div>
      <div className="rule-children">
        {group.conditions.map((c, i) => {
          const onChange = (n: RuleNode) => set((g) => void (g.conditions[i] = n));
          const onRemove = group.conditions.length > 1 ? () => set((g) => void g.conditions.splice(i, 1)) : undefined;
          return isGroup(c) ? (
            <GroupEditor key={i} group={c} depth={depth + 1} refs={refs} onChange={onChange} {...(onRemove && { onRemove })} />
          ) : (
            <ConditionEditor key={i} condition={c} refs={refs} onChange={onChange} {...(onRemove && { onRemove })} />
          );
        })}
      </div>
      {!full && (
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => set((g) => void g.conditions.push(defaultCondition('minimum_score', refs)))}>
            ＋ 條件
          </button>
          {canNest && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => set((g) => void g.conditions.push({ operator: 'OR', conditions: [defaultCondition('minimum_score', refs)] }))}
            >
              ＋ 條件群組
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RefSelect(props: { value: string; options: Option[]; label: string; onChange(v: string): void }) {
  const known = props.options.some((o) => o.id === props.value);
  return (
    <select value={props.value} aria-label={props.label} onChange={(e) => props.onChange(e.target.value)}>
      {!known && <option value={props.value}>（找不到：可能已刪除）</option>}
      {props.options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberInput(props: { value: number; min: number; max?: number; step?: number; label: string; onChange(v: number): void }) {
  return (
    <input
      type="number"
      className="num"
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={props.value}
      aria-label={props.label}
      onChange={(e) => props.onChange(Number(e.target.value))}
    />
  );
}

function ConditionEditor(props: { condition: RuleCondition; refs: Refs; onChange(c: RuleCondition): void; onRemove?: () => void }) {
  const { condition: c, refs } = props;
  const set = (patch: Record<string, unknown>) => props.onChange({ ...c, ...patch } as RuleCondition);
  const changeType = (type: RuleConditionType) => props.onChange({ ...defaultCondition(type, refs), ...(c.negate && { negate: true }) });

  let params: React.ReactNode = null;
  switch (c.type) {
    case 'required_activities_completed':
      break;
    case 'specific_activities_completed':
      params = (
        <select
          multiple
          size={Math.min(6, Math.max(2, refs.acts.length))}
          value={c.activity_ids}
          aria-label="指定活動"
          onChange={(e) => set({ activity_ids: [...e.target.selectedOptions].map((o) => o.value) })}
        >
          {refs.acts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'minimum_score':
      params = (
        <>
          <NumberInput value={c.value} min={0} max={100} label="總分門檻" onChange={(v) => set({ value: v })} /> 分（滿分 100）
        </>
      );
      break;
    case 'minimum_activity_score':
      params = (
        <>
          <RefSelect value={c.activity_id} options={refs.acts} label="活動" onChange={(v) => set({ activity_id: v })} />
          <NumberInput value={c.value} min={0} label="分數門檻" onChange={(v) => set({ value: v })} /> 分
        </>
      );
      break;
    case 'video_watch_ratio':
      params = (
        <>
          <RefSelect value={c.activity_id} options={refs.acts.filter((a) => a.activityType === 'video')} label="影片活動" onChange={(v) => set({ activity_id: v })} />
          <NumberInput value={Math.round(c.value * 100)} min={0} max={100} label="觀看比例" onChange={(v) => set({ value: v / 100 })} /> %
        </>
      );
      break;
    case 'attempt_status':
      params = (
        <>
          <RefSelect value={c.activity_id} options={refs.acts} label="活動" onChange={(v) => set({ activity_id: v })} />
          <select value={c.value} aria-label="作答狀態" onChange={(e) => set({ value: e.target.value as AttemptStatusTarget })}>
            {ATTEMPT_STATUS_TARGETS.map((s) => (
              <option key={s} value={s}>
                {ATTEMPT_STATUS_TARGET_LABELS[s]}
              </option>
            ))}
          </select>
        </>
      );
      break;
    case 'module_completed':
      params = <RefSelect value={c.module_id} options={refs.mods} label="單元" onChange={(v) => set({ module_id: v })} />;
      break;
    case 'lesson_completed':
      params = <RefSelect value={c.lesson_id} options={refs.lessons} label="課節" onChange={(v) => set({ lesson_id: v })} />;
      break;
    case 'time_spent_minimum':
      params = (
        <>
          <NumberInput value={c.value} min={0} label="分鐘" onChange={(v) => set({ value: v })} /> 分鐘，範圍
          <select
            value={c.scope === 'module' ? (c.scope_id ?? '') : ''}
            aria-label="計算範圍"
            onChange={(e) =>
              props.onChange(
                e.target.value
                  ? { type: 'time_spent_minimum', value: c.value, scope: 'module', scope_id: e.target.value, ...(c.negate && { negate: true }) }
                  : { type: 'time_spent_minimum', value: c.value, ...(c.negate && { negate: true }) },
              )
            }
          >
            <option value="">整門課程</option>
            {refs.mods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </>
      );
      break;
    case 'attempt_count_maximum':
      params = (
        <>
          <RefSelect value={c.activity_id} options={refs.acts} label="活動" onChange={(v) => set({ activity_id: v })} />
          <NumberInput value={c.value} min={0} label="次數上限" onChange={(v) => set({ value: v })} /> 次內完成
        </>
      );
      break;
    case 'manual_approval':
      params = (
        <select value={c.approver_role} aria-label="核可者" onChange={(e) => set({ approver_role: e.target.value })}>
          {APPROVER_ROLES.map((r) => (
            <option key={r} value={r}>
              由{ROLE_LABELS[r]}核可
            </option>
          ))}
        </select>
      );
      break;
  }

  return (
    <div className="rule-condition">
      <select value={c.type} aria-label="條件類型" onChange={(e) => changeType(e.target.value as RuleConditionType)}>
        {RULE_CONDITION_TYPES.map((t) => (
          <option key={t} value={t}>
            {RULE_CONDITION_LABELS[t]}
          </option>
        ))}
      </select>
      {params}
      <label className="check small" title="勾選後，此條件「不成立」才算符合">
        <input type="checkbox" checked={!!c.negate} onChange={(e) => set({ negate: e.target.checked || undefined })} />
        反向
      </label>
      {props.onRemove && (
        <button type="button" className="btn btn-small btn-ghost" onClick={props.onRemove} aria-label="移除條件">
          ✕
        </button>
      )}
    </div>
  );
}

// ======================================================================= AI 教練設定

const DEFAULT_POLICY: CoachPolicyDto = {
  responseMode: 'hint_first',
  maxDirectnessLevel: 2,
  allowAnswerRevealAfterAttempts: null,
  preferredLanguage: 'zh-TW',
  citationRequired: true,
  allowedKnowledgeScopes: ['course_source', 'verified_faq'],
  toneProfile: 'supportive',
  followUpQuestions: true,
  prohibitedTopics: [],
  extraInstructions: null,
};

/** 版本編輯頁的「AI 教練設定」卡片（PUT coach-policy，整組取代） */
export function CoachPolicyCard(props: { version: CourseVersionDetailDto; editable: boolean }) {
  const [p, setP] = useState<CoachPolicyDto>(props.version.coachPolicy ?? DEFAULT_POLICY);
  const [topics, setTopics] = useState(p.prohibitedTopics.join('\n'));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof CoachPolicyDto>(k: K, v: CoachPolicyDto[K]) => {
    setP((old) => ({ ...old, [k]: v }));
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: CoachPolicyDto = {
        ...p,
        prohibitedTopics: topics
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean),
        extraInstructions: p.extraInstructions?.trim() || null,
      };
      const r = await api<CoachPolicyDto>('PUT', `/api/course-versions/${props.version.id}/coach-policy`, body);
      setP(r);
      setTopics(r.prohibitedTopics.join('\n'));
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const toggleScope = (s: CoachPolicyDto['allowedKnowledgeScopes'][number]) =>
    set('allowedKnowledgeScopes', p.allowedKnowledgeScopes.includes(s) ? p.allowedKnowledgeScopes.filter((x) => x !== s) : [...p.allowedKnowledgeScopes, s]);

  return (
    <section className="card">
      <div className="row structure-head">
        <h2 className="grow">AI 教練設定</h2>
        {props.editable && dirty && <span className="badge badge-grace">尚未儲存</span>}
        {props.editable && (
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? '儲存中…' : '儲存教練設定'}
          </button>
        )}
      </div>
      <p className="muted small">隨版本凍結：發布後學員使用的就是這份設定，要調整需建立新版本。</p>
      {saved && <Notice kind="ok">AI 教練設定已儲存。</Notice>}
      <ErrorAlert error={error} />
      <fieldset disabled={!props.editable || busy} className="form-grid">
        <Field label="回應模式">
          <select value={p.responseMode} onChange={(e) => set('responseMode', e.target.value as CoachPolicyDto['responseMode'])}>
            {COACH_RESPONSE_MODES.map((m) => (
              <option key={m} value={m}>
                {COACH_RESPONSE_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`直接程度上限：${p.maxDirectnessLevel} / 5`} hint="1＝只給提示；5＝可完整解說">
          <input type="range" min={1} max={5} value={p.maxDirectnessLevel} onChange={(e) => set('maxDirectnessLevel', Number(e.target.value))} />
        </Field>
        <Field label="嘗試幾次後可給答案" hint={`空白＝永不直接給答案（1～${COACH_POLICY_LIMITS.revealAfterMax}）`}>
          <input
            type="number"
            min={1}
            max={COACH_POLICY_LIMITS.revealAfterMax}
            value={p.allowAnswerRevealAfterAttempts ?? ''}
            onChange={(e) => set('allowAnswerRevealAfterAttempts', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="回答語言">
          <select value={p.preferredLanguage} onChange={(e) => set('preferredLanguage', e.target.value as CoachPolicyDto['preferredLanguage'])}>
            {COACH_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {COACH_LANGUAGE_LABELS[l]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="語氣">
          <select value={p.toneProfile} onChange={(e) => set('toneProfile', e.target.value as CoachPolicyDto['toneProfile'])}>
            {COACH_TONE_PROFILES.map((t) => (
              <option key={t} value={t}>
                {COACH_TONE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="可參考的知識" hint="至少選一項">
          <div className="check-row">
            {COACH_KNOWLEDGE_SCOPES.map((s) => (
              <label key={s} className="check">
                <input type="checkbox" checked={p.allowedKnowledgeScopes.includes(s)} onChange={() => toggleScope(s)} />
                {COACH_KNOWLEDGE_SCOPE_LABELS[s]}
              </label>
            ))}
          </div>
        </Field>
        <label className="check">
          <input type="checkbox" checked={p.citationRequired} onChange={(e) => set('citationRequired', e.target.checked)} />
          回答必須附上教材引用（建議開啟；找不到依據時會改說「教材中找不到」）
        </label>
        <label className="check">
          <input type="checkbox" checked={p.followUpQuestions} onChange={(e) => set('followUpQuestions', e.target.checked)} />
          回答後提出引導式的追問
        </label>
        <Field label="不討論的主題" hint={`每行一個，最多 ${COACH_POLICY_LIMITS.prohibitedTopics} 個`}>
          <textarea
            rows={3}
            value={topics}
            onChange={(e) => {
              setTopics(e.target.value);
              setDirty(true);
              setSaved(false);
            }}
          />
        </Field>
        <Field label="給教練的補充說明（選填）" hint={`最多 ${COACH_POLICY_LIMITS.extraInstructionsChars} 字；會附在教練設定後，但不能覆寫安全規則`}>
          <textarea
            rows={3}
            maxLength={COACH_POLICY_LIMITS.extraInstructionsChars}
            value={p.extraInstructions ?? ''}
            onChange={(e) => set('extraInstructions', e.target.value || null)}
          />
        </Field>
      </fieldset>
    </section>
  );
}

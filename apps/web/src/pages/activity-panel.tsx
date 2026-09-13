import type {
  ActivityResultDto,
  ActivityRuntimeDto,
  ChoiceQuizConfig,
  OutlineActivityDto,
} from '@iac/contracts';
import { useState } from 'react';
import { api } from '../api/client';
import { ErrorAlert, Notice } from '../components/ui';
import { ACTIVITY_STATE_LABELS, ACTIVITY_TYPE_LABELS, RESULT_STATUS_BADGE, RESULT_STATUS_LABELS } from '../format';
import { issueText, seededShuffle } from '../learn-lib';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** 結果中 target（題目／參數／項目 id）對應的顯示名稱 */
function targetLabels(runtime: ActivityRuntimeDto): Record<string, string> {
  const c = runtime.config;
  const out: Record<string, string> = {};
  list(c['questions']).forEach((q, i) => (out[String(q['id'])] = `第 ${i + 1} 題`));
  list(c['parameters']).forEach((p) => (out[String(p['id'])] = String(p['label'] ?? p['id'])));
  list(c['steps'] ?? c['events']).forEach((s) => (out[String(s['id'])] = String(s['label'] ?? s['title'] ?? s['id'])));
  return out;
}

/**
 * 單一活動：狀態、開始／繼續作答、各元件的作答介面、送出後的結果（UC-LRN-002/004/006/007/008）。
 * 成績一律由伺服器產生——這裡只送原始作答（ADR-024）。
 */
export function ActivityPanel({ activity: a, canLearn, onChanged }: { activity: OutlineActivityDto; canLearn: boolean; onChanged(): void }) {
  const [runtime, setRuntime] = useState<ActivityRuntimeDto | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [result, setResult] = useState<{ r: ActivityResultDto; labels: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const attemptsLeft = a.maxAttempts === null || a.attempts < a.maxAttempts;
  const done = a.state === 'completed';

  async function start() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const rt = await api<ActivityRuntimeDto>('GET', `/api/activities/${a.id}/runtime`);
      const id = rt.inProgressAttemptId ?? (await api<{ attemptId: string }>('POST', `/api/activities/${a.id}/attempts`)).attemptId;
      setRuntime(rt);
      setAttemptId(id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function submit(input: unknown) {
    if (!attemptId || !runtime) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<ActivityResultDto>('POST', `/api/attempts/${attemptId}/submit`, { input });
      setResult({ r, labels: targetLabels(runtime) });
      setRuntime(null);
      setAttemptId(null);
      onChanged();
    } catch (e) {
      // 輸入格式錯誤（422）時作答仍在進行中，可修正後重送
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="activity-card" id={`activity-${a.id}`}>
      <div className="row structure-head">
        <strong className="grow">{a.title}</strong>
        <span className="muted small">
          {ACTIVITY_TYPE_LABELS[a.activityType]}
          {a.isRequired ? '・必修' : '・選修'}
        </span>
        <span className={`badge ${done ? 'badge-active' : a.state === 'locked' ? '' : 'badge-grace'}`}>{ACTIVITY_STATE_LABELS[a.state]}</span>
      </div>
      <p className="muted small">
        {a.best && (
          <>
            最佳結果：{RESULT_STATUS_LABELS[a.best.status]}
            {a.best.score !== null && `（${a.best.score}／${a.best.maxScore}）`}・
          </>
        )}
        已作答 {a.attempts} 次{a.maxAttempts !== null && `，上限 ${a.maxAttempts} 次`}
      </p>

      <ErrorAlert error={error} />
      {result && <ResultView result={result.r} labels={result.labels} />}

      {a.state === 'locked' ? (
        <p className="muted">🔒 {a.lockReason === 'sequence' ? '請先完成前面的內容。' : '請先完成這個活動的先修條件。'}</p>
      ) : !a.supported ? (
        <Notice kind="info">這種活動類型的作答介面尚未開放。</Notice>
      ) : !canLearn ? null : runtime && attemptId ? (
        <ActivityInput runtime={runtime} attemptId={attemptId} busy={busy} onSubmit={(input) => void submit(input)} />
      ) : attemptsLeft ? (
        <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy}>
          {busy ? '載入中…' : a.state === 'in_progress' ? '繼續作答' : a.attempts > 0 || result ? '再做一次' : '開始'}
        </button>
      ) : (
        <p className="muted small">已達作答次數上限。</p>
      )}
    </div>
  );
}

function ResultView({ result: r, labels }: { result: ActivityResultDto; labels: Record<string, string> }) {
  const fb = r.feedbackData;
  return (
    <div className="result">
      {r.completionChanged && <Notice kind="ok">🎉 恭喜！你已完成這門課程。</Notice>}
      <p>
        <span className={`badge ${RESULT_STATUS_BADGE[r.status]}`}>{RESULT_STATUS_LABELS[r.status]}</span>{' '}
        {r.score !== null && (
          <strong>
            {r.score}／{r.maxScore} 分
          </strong>
        )}
        {typeof fb['correctCount'] === 'number' && (
          <span className="muted small">
            （答對 {String(fb['correctCount'])}／{String(fb['total'])} 題）
          </span>
        )}
      </p>
      {r.issues.length > 0 && (
        <ul className="issue-list">
          {r.issues.map((i, k) => (
            <li key={k}>{issueText(i, i.target ? labels[i.target] : undefined)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 依 componentType 選擇作答介面；未知的類型不提供作答 */
function ActivityInput(props: { runtime: ActivityRuntimeDto; attemptId: string; busy: boolean; onSubmit(input: unknown): void }) {
  const { runtime: rt } = props;
  const instructions = typeof rt.config['instructions'] === 'string' ? rt.config['instructions'] : null;
  const body = (() => {
    switch (rt.componentType) {
      case 'builtin.reading':
        return (
          <button type="button" className="btn btn-primary" disabled={props.busy} onClick={() => props.onSubmit({})}>
            我已讀完
          </button>
        );
      case 'builtin.video':
        return (
          <>
            <Notice kind="info">影片播放器將於素材管理上線後提供；目前請依老師提供的方式觀看，看完後按下方按鈕。</Notice>
            <button type="button" className="btn btn-primary" disabled={props.busy} onClick={() => props.onSubmit({ watchedRatio: 1 })}>
              我已看完影片
            </button>
          </>
        );
      case 'builtin.quiz':
        return <QuizInput config={rt.config as unknown as ChoiceQuizConfig} busy={props.busy} onSubmit={props.onSubmit} />;
      case 'native.ParameterControl':
        return <ParameterInput config={rt.config} busy={props.busy} onSubmit={props.onSubmit} />;
      case 'native.StepSequence':
      case 'native.Timeline':
        return <SequenceInput key={props.attemptId} config={rt.config} seed={props.attemptId} busy={props.busy} onSubmit={props.onSubmit} />;
      default:
        return <Notice kind="info">這種活動類型的作答介面尚未開放。</Notice>;
    }
  })();
  return (
    <div className="activity-input">
      {instructions && <p>{instructions}</p>}
      {body}
    </div>
  );
}

function QuizInput({ config, busy, onSubmit }: { config: ChoiceQuizConfig; busy: boolean; onSubmit(input: unknown): void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const toggle = (qid: string, oid: string, multiple: boolean) =>
    setAnswers((cur) => {
      const picked = cur[qid] ?? [];
      const next = multiple ? (picked.includes(oid) ? picked.filter((x) => x !== oid) : [...picked, oid]) : [oid];
      return { ...cur, [qid]: next };
    });
  const questions = config.questions ?? [];
  const unanswered = questions.filter((q) => !(answers[q.id]?.length)).length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (unanswered && !window.confirm(`還有 ${unanswered} 題未作答，確定要送出？`)) return;
        onSubmit({ answers });
      }}
    >
      {questions.map((q, i) => (
        <fieldset key={q.id} className="quiz-question" disabled={busy}>
          <legend>
            {i + 1}. {q.prompt}
            {q.multiple && <span className="muted small">（可複選）</span>}
          </legend>
          {q.options.map((o) => (
            <label key={o.id} className="check">
              <input
                type={q.multiple ? 'checkbox' : 'radio'}
                name={`q-${q.id}`}
                checked={(answers[q.id] ?? []).includes(o.id)}
                onChange={() => toggle(q.id, o.id, !!q.multiple)}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      ))}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? '送出中…' : '送出答案'}
      </button>
    </form>
  );
}

function ParameterInput({ config, busy, onSubmit }: { config: Obj; busy: boolean; onSubmit(input: unknown): void }) {
  const params = list(config['parameters']).map((p) => ({
    id: String(p['id']),
    label: String(p['label'] ?? p['id']),
    unit: typeof p['unit'] === 'string' ? p['unit'] : '',
    min: Number(p['min'] ?? 0),
    max: Number(p['max'] ?? 100),
    step: Number(p['step'] ?? 1),
  }));
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(params.map((p) => [p.id, p.min])));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ values });
      }}
    >
      {params.map((p) => (
        <label key={p.id} className="param-row">
          <span>{p.label}</span>
          <input
            type="range"
            min={p.min}
            max={p.max}
            step={p.step}
            value={values[p.id]}
            disabled={busy}
            onChange={(e) => setValues((v) => ({ ...v, [p.id]: Number(e.target.value) }))}
          />
          <strong>
            {values[p.id]}
            {p.unit}
          </strong>
        </label>
      ))}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? '送出中…' : '送出'}
      </button>
    </form>
  );
}

function SequenceInput({ config, seed, busy, onSubmit }: { config: Obj; seed: string; busy: boolean; onSubmit(input: unknown): void }) {
  const items = list(config['steps'] ?? config['events']).map((s) => ({ id: String(s['id']), label: String(s['label'] ?? s['title'] ?? s['id']) }));
  const [order, setOrder] = useState(() => seededShuffle(items, seed));
  const move = (i: number, d: number) =>
    setOrder((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const n = [...cur];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ order: order.map((x) => x.id) });
      }}
    >
      <p className="muted small">用 ↑ ↓ 調整順序，排好後送出。</p>
      <ol className="seq-list">
        {order.map((x, i) => (
          <li key={x.id}>
            <span className="grow">{x.label}</span>
            <button type="button" className="btn btn-small btn-ghost" aria-label={`上移 ${x.label}`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              aria-label={`下移 ${x.label}`}
              disabled={busy || i === order.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? '送出中…' : '送出'}
      </button>
    </form>
  );
}

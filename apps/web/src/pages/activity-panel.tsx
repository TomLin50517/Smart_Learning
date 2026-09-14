import type {
  ActivityResultDto,
  ActivityRuntimeDto,
  ChoiceQuizConfig,
  OutlineActivityDto,
} from '@iac/contracts';
import { assetUrl, VIDEO_SAMPLE_SEC } from '@iac/contracts';
import { useRef, useState } from 'react';
import { api } from '../api/client';
import { ErrorAlert, Notice } from '../components/ui';
import { ACTIVITY_STATE_LABELS, ACTIVITY_TYPE_LABELS, RESULT_STATUS_BADGE, RESULT_STATUS_LABELS } from '../format';
import { useLearningEvents, WatchTracker, type EventQueue } from '../learn-events';
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
export function ActivityPanel({
  activity: a,
  canLearn,
  onChanged,
  onAskCoach,
}: {
  activity: OutlineActivityDto;
  canLearn: boolean;
  onChanged(): void;
  /** 有提供時，結果旁顯示「請 AI 教練看看這次結果」（SD §6.21） */
  onAskCoach?: ((attemptId: string) => void) | undefined;
}) {
  const [runtime, setRuntime] = useState<ActivityRuntimeDto | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [result, setResult] = useState<{ r: ActivityResultDto; labels: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 作答進行中：heartbeat 與影片事件（SD §6.13）
  const queue = useLearningEvents(runtime && attemptId ? attemptId : null);

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
      // 先送出尚未送出的學習事件——影片的觀看比例由伺服器依事件計算
      await queue?.flush();
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
        {a.watchedRatio !== null && a.watchedRatio > 0 && `・已觀看 ${Math.round(a.watchedRatio * 100)}%`}
      </p>

      <ErrorAlert error={error} />
      {result && <ResultView result={result.r} labels={result.labels} onAskCoach={onAskCoach} />}

      {a.state === 'locked' ? (
        <p className="muted">🔒 {a.lockReason === 'sequence' ? '請先完成前面的內容。' : '請先完成這個活動的先修條件。'}</p>
      ) : !a.supported ? (
        <Notice kind="info">這種活動類型的作答介面尚未開放。</Notice>
      ) : !canLearn ? null : runtime && attemptId ? (
        <ActivityInput runtime={runtime} attemptId={attemptId} queue={queue} busy={busy} onSubmit={(input) => void submit(input)} />
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

function ResultView({ result: r, labels, onAskCoach }: { result: ActivityResultDto; labels: Record<string, string>; onAskCoach: ((attemptId: string) => void) | undefined }) {
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
      {onAskCoach && (
        <button type="button" className="btn btn-small" onClick={() => onAskCoach(r.attemptId)}>
          請 AI 教練看看這次結果
        </button>
      )}
    </div>
  );
}

/** 依 componentType 選擇作答介面；未知的類型不提供作答 */
function ActivityInput(props: { runtime: ActivityRuntimeDto; attemptId: string; queue: EventQueue | null; busy: boolean; onSubmit(input: unknown): void }) {
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
        return <VideoInput config={rt.config} queue={props.queue} busy={props.busy} onSubmit={props.onSubmit} />;
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

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (r: number) => `${Math.round(r * 100)}%`;

/**
 * 影片（SD §6.13）：config.video_url 為 http(s) 網址時以播放器觀看，只有連續播放的片段算看過（拖曳跳過不算）；
 * 觀看區間每 15 秒或每 10% 以 video.progressed 回報，完成與否由伺服器依事件判定。
 * 沒有網址（請學員依老師指示在別處觀看）時維持「我已看完影片」的自行確認。
 */
function VideoInput({ config, queue, busy, onSubmit }: { config: Obj; queue: EventQueue | null; busy: boolean; onSubmit(input: unknown): void }) {
  const raw = config['video_url'];
  const asset = config['video_asset_id'];
  // 素材庫的影片優先（網址與素材只能擇一，發布前已檢查）
  const url = typeof asset === 'string' && asset ? assetUrl(asset) : typeof raw === 'string' && /^https?:\/\/\S+$/i.test(raw) ? raw : null;
  const required = typeof config['completion_ratio'] === 'number' ? config['completion_ratio'] : 0.9;
  const tracker = useRef(new WatchTracker());
  const sent = useRef({ at: 0, ratio: 0, started: false });
  const [ratio, setRatio] = useState(0);

  if (!url) {
    return (
      <>
        <Notice kind="info">請依老師提供的方式觀看影片，看完後按下方按鈕。</Notice>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onSubmit({ watchedRatio: 1 })}>
          我已看完影片
        </button>
      </>
    );
  }

  const report = (v: HTMLVideoElement, force = false) => {
    const dur = v.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const r = tracker.current.ratio(dur);
    setRatio(r);
    const now = Date.now();
    if (queue && (force || now - sent.current.at >= VIDEO_SAMPLE_SEC * 1000 || r - sent.current.ratio >= 0.1)) {
      queue.push('video.progressed', { position_sec: round1(Math.min(v.currentTime, dur)), duration_sec: round1(dur), watched_ranges: tracker.current.watched(dur) });
      sent.current = { ...sent.current, at: now, ratio: r };
    }
  };

  return (
    <>
      <video
        className="video-player"
        controls
        preload="metadata"
        src={url}
        onPlay={(e) => {
          const dur = e.currentTarget.duration;
          if (!sent.current.started && queue && Number.isFinite(dur) && dur > 0) {
            sent.current.started = true;
            queue.push('video.started', { duration_sec: round1(dur) });
          }
        }}
        onTimeUpdate={(e) => {
          if (!e.currentTarget.paused) tracker.current.tick(e.currentTarget.currentTime);
          report(e.currentTarget);
        }}
        onSeeking={() => tracker.current.break()}
        onPause={(e) => {
          tracker.current.break();
          report(e.currentTarget, true);
          void queue?.flush();
        }}
        onEnded={(e) => {
          report(e.currentTarget, true);
          void queue?.flush();
        }}
      >
        你的瀏覽器無法播放這個影片。
      </video>
      <p className="muted small">
        已觀看 {pct(ratio)}，需達 {pct(required)} 才算完成（拖曳跳過的部分不計入）。
      </p>
      <button type="button" className={`btn ${ratio >= required ? 'btn-primary' : ''}`} disabled={busy} onClick={() => onSubmit({})}>
        {busy ? '送出中…' : ratio >= required ? '完成觀看' : '先送出目前進度'}
      </button>
    </>
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

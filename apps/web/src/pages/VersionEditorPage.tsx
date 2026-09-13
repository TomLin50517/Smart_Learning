import {
  ACTIVITY_TYPES,
  NAVIGATION_MODES,
  type ActivityDto,
  type ActivityType,
  type CourseVersionDetailDto,
  type InteractiveDefinitionDto,
  type LessonBlock,
  type LessonDto,
  type ModuleDto,
  type NavigationMode,
} from '@iac/contracts';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { ACTIVITY_TYPE_LABELS, NAVIGATION_MODE_LABELS, VERSION_STATUS_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';
import { PublishPanel } from './publish-panel';
import { CoachPolicyCard, CompletionRulesCard } from './version-settings';

interface EditState {
  title: string;
  summary: string;
  navigationMode: NavigationMode;
  modules: ModuleDto[];
}

/** 活動的 JSON 欄位以文字編輯，儲存時才解析 */
interface JsonText {
  config: string;
  answerKey: string;
  prerequisite: string;
}

const pretty = (v: unknown) => (v == null ? '' : JSON.stringify(v, null, 2));

function toState(v: CourseVersionDetailDto): { state: EditState; json: Record<string, JsonText> } {
  const json: Record<string, JsonText> = {};
  for (const m of v.modules)
    for (const l of m.lessons)
      for (const a of l.activities) json[a.id] = { config: pretty(a.config), answerKey: pretty(a.answerKey), prerequisite: pretty(a.prerequisite) };
  return { state: { title: v.title, summary: v.summary ?? '', navigationMode: v.navigationMode, modules: structuredClone(v.modules) }, json };
}

function move<T>(arr: T[], i: number, delta: number): void {
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j]!, arr[i]!];
}

const newActivity = (): ActivityDto => ({
  id: crypto.randomUUID(),
  title: '新活動',
  activityType: 'reading',
  interactiveDefinitionId: null,
  config: {},
  answerKey: null,
  isRequired: true,
  maxAttempts: null,
  weight: 1,
  maxScore: 100,
  prerequisite: null,
});

type JsonParse = { ok: true; value: Record<string, unknown> | null } | { ok: false };
function parseJsonObject(text: string, allowEmpty: boolean): JsonParse {
  if (!text.trim()) return allowEmpty ? { ok: true, value: null } : { ok: true, value: {} };
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * /app/courses/:courseId/versions/:versionId/edit（SD §7.1 Course Page Builder 的基本版）。
 * 只有草稿可編輯；已發布版本顯示為唯讀，並提示改用「複製為新版本」。
 * 儲存時送出整個課程結構（PATCH 整組取代），新項目的 id 在瀏覽器產生，讓內容區塊能在儲存前引用新活動。
 */
export function VersionEditorPage() {
  const { courseId = '', versionId = '' } = useParams();
  const me = useMe();
  const version = useApi<CourseVersionDetailDto>(can(me, 'course.version.read') ? `/api/course-versions/${versionId}` : null);
  const canWrite = can(me, 'course.version.write');
  const defs = useApi<InteractiveDefinitionDto[]>(can(me, 'course.version.read') ? '/api/interactive-definitions' : null);
  const [state, setState] = useState<EditState | null>(null);
  const [json, setJson] = useState<Record<string, JsonText>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 最近一次儲存後的版本內容：完成條件以「已儲存」的結構選擇引用對象
  const [latest, setLatest] = useState<CourseVersionDetailDto | null>(null);
  useTitle(version.data ? `編輯 v${version.data.versionNo}` : '課程版本');

  useEffect(() => {
    if (!version.data) return;
    const s = toState(version.data);
    setState(s.state);
    setJson(s.json);
    setDirty(false);
  }, [version.data]);

  if (!can(me, 'course.version.read')) return <Forbidden />;
  if (!version.data || !state) return version.loading ? <Spinner /> : <ErrorAlert error={version.error} />;
  const v = version.data;
  const editable = v.editable && canWrite && me.licenseCapabilities.authoringAllowed;

  const update = (fn: (d: EditState) => void) => {
    setState((d) => {
      const n = structuredClone(d!);
      fn(n);
      return n;
    });
    setDirty(true);
    setSaved(false);
  };
  const setJsonField = (id: string, key: keyof JsonText, text: string) => {
    setJson((j) => ({ ...j, [id]: { ...(j[id] ?? { config: '', answerKey: '', prerequisite: '' }), [key]: text } }));
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    if (!state) return;
    setLocalError(null);
    setError(null);
    const modules = structuredClone(state.modules);
    for (const [mi, m] of modules.entries())
      for (const [li, l] of m.lessons.entries())
        for (const [ai, a] of l.activities.entries()) {
          const t = json[a.id] ?? { config: '', answerKey: '', prerequisite: '' };
          const where = `第 ${mi + 1} 單元 › 第 ${li + 1} 課節 › 第 ${ai + 1} 活動「${a.title}」`;
          const config = parseJsonObject(t.config, false);
          const answerKey = parseJsonObject(t.answerKey, true);
          const prerequisite = parseJsonObject(t.prerequisite, true);
          if (!config.ok || !answerKey.ok || !prerequisite.ok) {
            setLocalError(`${where}：設定、答案或先修條件不是合法的 JSON 物件。`);
            return;
          }
          a.config = config.value ?? {};
          a.answerKey = answerKey.value;
          a.prerequisite = prerequisite.value;
        }
    setBusy(true);
    try {
      const r = await api<CourseVersionDetailDto>('PATCH', `/api/course-versions/${v.id}`, {
        title: state.title.trim(),
        summary: state.summary.trim() || null,
        navigationMode: state.navigationMode,
        modules,
      });
      const s = toState(r);
      setState(s.state);
      setJson(s.json);
      setLatest(r);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={`v${v.versionNo}・${VERSION_STATUS_LABELS[v.status]}`}
        subtitle={state.title}
        actions={
          editable ? (
            <>
              {dirty && <span className="badge badge-grace">尚未儲存</span>}
              <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty}>
                {busy ? '儲存中…' : '儲存'}
              </button>
            </>
          ) : undefined
        }
      />
      <p>
        <Link to={`/app/courses/${courseId}`}>← 課程總覽</Link>
      </p>
      {!v.editable && (
        <Notice kind="info">
          此版本為「{VERSION_STATUS_LABELS[v.status]}」，內容不可修改。要調整請回到課程總覽，將已發布的版本複製為新版本。
          {v.contentSnapshotHash && (
            <div className="muted small" title={v.contentSnapshotHash}>
              內容雜湊：{v.contentSnapshotHash.slice(0, 23)}…（發布時計算，可用來確認內容未被竄改）
            </div>
          )}
        </Notice>
      )}
      {v.editable && !canWrite && <Notice kind="info">您可以檢視此草稿，但沒有編輯權限。</Notice>}
      {saved && <Notice kind="ok">已儲存。</Notice>}
      {localError && (
        <div className="alert alert-error" role="alert">
          {localError}
        </div>
      )}
      <ErrorAlert error={error} />

      <fieldset disabled={!editable || busy} className="editor-root">
        <section className="card">
          <h2>基本資訊</h2>
          <div className="form-grid">
            <Field label="版本名稱">
              <input maxLength={200} value={state.title} onChange={(e) => update((d) => void (d.title = e.target.value))} />
            </Field>
            <Field label="學習順序">
              <select value={state.navigationMode} onChange={(e) => update((d) => void (d.navigationMode = e.target.value as NavigationMode))}>
                {NAVIGATION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {NAVIGATION_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="簡介">
              <textarea rows={2} maxLength={5000} value={state.summary} onChange={(e) => update((d) => void (d.summary = e.target.value))} />
            </Field>
          </div>
        </section>

        {state.modules.map((m, mi) => (
          <section className="card module-card" key={m.id}>
            <div className="row structure-head">
              <strong>第 {mi + 1} 單元</strong>
              <input className="grow" maxLength={200} value={m.title} aria-label="單元名稱" onChange={(e) => update((d) => void (d.modules[mi]!.title = e.target.value))} />
              <label className="check">
                <input type="checkbox" checked={m.isRequired} onChange={(e) => update((d) => void (d.modules[mi]!.isRequired = e.target.checked))} />
                必修
              </label>
              <Mover onUp={() => update((d) => move(d.modules, mi, -1))} onDown={() => update((d) => move(d.modules, mi, 1))} />
              <button type="button" className="btn btn-small btn-danger" onClick={() => window.confirm(`刪除「${m.title}」及其所有課節與活動？`) && update((d) => void d.modules.splice(mi, 1))}>
                刪除
              </button>
            </div>
            <textarea rows={1} maxLength={2000} placeholder="單元說明（選填）" value={m.description ?? ''} onChange={(e) => update((d) => void (d.modules[mi]!.description = e.target.value || null))} />

            {m.lessons.map((l, li) => (
              <LessonEditor
                key={l.id}
                lesson={l}
                label={`第 ${mi + 1}-${li + 1} 課節`}
                defs={defs.data ?? []}
                json={json}
                onJson={setJsonField}
                update={(fn) => update((d) => fn(d.modules[mi]!.lessons[li]!))}
                onMove={(delta) => update((d) => move(d.modules[mi]!.lessons, li, delta))}
                onRemove={() => window.confirm(`刪除課節「${l.title}」及其活動？`) && update((d) => void d.modules[mi]!.lessons.splice(li, 1))}
              />
            ))}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => update((d) => void d.modules[mi]!.lessons.push({ id: crypto.randomUUID(), title: '新課節', isRequired: true, contentBlocks: [], activities: [] }))}
            >
              ＋ 新增課節
            </button>
          </section>
        ))}

        <button
          type="button"
          className="btn"
          onClick={() => update((d) => void d.modules.push({ id: crypto.randomUUID(), title: '新單元', description: null, isRequired: true, lessons: [] }))}
        >
          ＋ 新增單元
        </button>
      </fieldset>

      <CompletionRulesCard
        key={`rules-${(latest ?? v).id}-${latest ? 'saved' : 'loaded'}`}
        version={latest ?? v}
        editable={v.editable && can(me, 'course.completion_rule.write') && me.licenseCapabilities.authoringAllowed}
        structureDirty={dirty}
      />
      <CoachPolicyCard key={`policy-${v.id}`} version={v} editable={v.editable && can(me, 'course.coach_policy.write') && me.licenseCapabilities.authoringAllowed} />

      {(v.status === 'draft' || v.status === 'review') && can(me, 'course.version.validate') && (
        <PublishPanel
          version={latest ?? v}
          canValidate
          canPublish={can(me, 'course.version.publish') && me.licenseCapabilities.authoringAllowed}
          blocked={dirty ? '課程結構有尚未儲存的變更，請先儲存再發布。' : null}
          onPublished={() => {
            setLatest(null);
            version.reload();
          }}
        />
      )}
    </>
  );
}

function Mover({ onUp, onDown }: { onUp(): void; onDown(): void }) {
  return (
    <span className="mover">
      <button type="button" className="btn btn-small btn-ghost" onClick={onUp} aria-label="上移">
        ↑
      </button>
      <button type="button" className="btn btn-small btn-ghost" onClick={onDown} aria-label="下移">
        ↓
      </button>
    </span>
  );
}

function LessonEditor(props: {
  lesson: LessonDto;
  label: string;
  defs: InteractiveDefinitionDto[];
  json: Record<string, JsonText>;
  onJson(id: string, key: keyof JsonText, text: string): void;
  update(fn: (l: LessonDto) => void): void;
  onMove(delta: number): void;
  onRemove(): void;
}) {
  const { lesson: l, update } = props;
  return (
    <details className="lesson" open>
      <summary>
        {props.label}：{l.title}
        <span className="muted small">
          （{l.contentBlocks.length} 個內容區塊、{l.activities.length} 個活動）
        </span>
      </summary>
      <div className="row structure-head">
        <input className="grow" maxLength={200} value={l.title} aria-label="課節名稱" onChange={(e) => update((x) => void (x.title = e.target.value))} />
        <label className="check">
          <input type="checkbox" checked={l.isRequired} onChange={(e) => update((x) => void (x.isRequired = e.target.checked))} />
          必修
        </label>
        <Mover onUp={() => props.onMove(-1)} onDown={() => props.onMove(1)} />
        <button type="button" className="btn btn-small btn-danger" onClick={props.onRemove}>
          刪除
        </button>
      </div>

      <h4>內容</h4>
      {l.contentBlocks.map((b, bi) => (
        <div className="block" key={bi}>
          <BlockEditor block={b} activities={l.activities} onChange={(nb) => update((x) => void (x.contentBlocks[bi] = nb))} />
          <span className="mover">
            <Mover onUp={() => update((x) => move(x.contentBlocks, bi, -1))} onDown={() => update((x) => move(x.contentBlocks, bi, 1))} />
            <button type="button" className="btn btn-small btn-ghost" onClick={() => update((x) => void x.contentBlocks.splice(bi, 1))} aria-label="移除區塊">
              ✕
            </button>
          </span>
        </div>
      ))}
      <div className="row">
        <span className="muted small">新增區塊：</span>
        <button type="button" className="btn btn-small" onClick={() => update((x) => void x.contentBlocks.push({ type: 'richtext', markdown: '' }))}>
          文字
        </button>
        <button type="button" className="btn btn-small" onClick={() => update((x) => void x.contentBlocks.push({ type: 'callout', variant: 'info', body: '' }))}>
          提示框
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={l.activities.length === 0}
          title={l.activities.length === 0 ? '請先新增活動' : undefined}
          onClick={() => update((x) => void x.contentBlocks.push({ type: 'activity', activityId: x.activities[0]!.id }))}
        >
          放置活動
        </button>
      </div>

      <h4>活動</h4>
      {l.activities.map((a, ai) => (
        <ActivityEditor
          key={a.id}
          activity={a}
          index={ai}
          defs={props.defs}
          json={props.json[a.id] ?? { config: '', answerKey: '', prerequisite: '' }}
          onJson={(k, t) => props.onJson(a.id, k, t)}
          update={(fn) => update((x) => fn(x.activities[ai]!))}
          onMove={(delta) => update((x) => move(x.activities, ai, delta))}
          onRemove={() =>
            update((x) => {
              x.activities.splice(ai, 1);
              // 同時移除指向此活動的內容區塊，避免儲存時被判為無效引用
              x.contentBlocks = x.contentBlocks.filter((b) => !(b.type === 'activity' && b.activityId === a.id));
            })
          }
        />
      ))}
      <button type="button" className="btn btn-small" onClick={() => update((x) => void x.activities.push(newActivity()))}>
        ＋ 新增活動
      </button>
    </details>
  );
}

function BlockEditor({ block: b, activities, onChange }: { block: LessonBlock; activities: ActivityDto[]; onChange(b: LessonBlock): void }) {
  switch (b.type) {
    case 'richtext':
      return (
        <Field label="文字（Markdown）">
          <textarea rows={4} value={b.markdown} onChange={(e) => onChange({ ...b, markdown: e.target.value })} />
        </Field>
      );
    case 'callout':
      return (
        <div className="row grow">
          <select value={b.variant} onChange={(e) => onChange({ ...b, variant: e.target.value as 'info' | 'warning' | 'success' })} aria-label="提示框樣式">
            <option value="info">資訊</option>
            <option value="warning">注意</option>
            <option value="success">成功</option>
          </select>
          <textarea className="grow" rows={2} value={b.body} onChange={(e) => onChange({ ...b, body: e.target.value })} aria-label="提示框內容" />
        </div>
      );
    case 'activity':
      return (
        <Field label="放置活動">
          <select value={b.activityId} onChange={(e) => onChange({ ...b, activityId: e.target.value })}>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'image':
    case 'video':
      // 素材上傳於 Phase 2 導入；既有區塊保留並可移除
      return (
        <p className="muted small">
          {b.type === 'image' ? '圖片' : '影片'}區塊（素材 {b.assetId}）——素材管理將於後續版本提供
        </p>
      );
  }
}

/** 影片活動的設定欄位（SD §6.13）：直接改寫 config JSON 文字，與進階區的 JSON 同步 */
function VideoConfigFields({ text, onChange }: { text: string; onChange(text: string): void }) {
  let cfg: Record<string, unknown> | null = {};
  if (text.trim()) {
    try {
      const v: unknown = JSON.parse(text);
      cfg = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      cfg = null;
    }
  }
  if (!cfg) return <p className="field-error">進階區的「設定 config」不是有效的 JSON，修正後才能使用影片欄位。</p>;
  const current = cfg;
  const set = (key: string, value: string | number | null) => {
    const next = { ...current };
    if (value === null || value === '') delete next[key];
    else next[key] = value;
    onChange(Object.keys(next).length ? JSON.stringify(next, null, 2) : '');
  };
  const numText = (v: unknown) => (typeof v === 'number' ? String(v) : '');
  const toNum = (s: string) => (s.trim() === '' ? null : Number(s));
  return (
    <div className="form-grid">
      <Field label="影片網址" hint="瀏覽器可直接播放的 http(s) 網址（MP4、WebM）。留空：學員依老師指示在別處觀看，看完自行確認">
        <input type="url" maxLength={2000} placeholder="https://" value={typeof current['video_url'] === 'string' ? current['video_url'] : ''} onChange={(e) => set('video_url', e.target.value.trim())} />
      </Field>
      <Field label="影片長度（秒）" hint="選填；未填時以播放器讀到的長度為準">
        <input type="number" min={1} max={86400} value={numText(current['duration_sec'])} onChange={(e) => set('duration_sec', toNum(e.target.value))} />
      </Field>
      <Field label="完成比例" hint="觀看比例達此值才算完成（0.1～1），預設 0.9">
        <input type="number" min={0.1} max={1} step={0.05} value={numText(current['completion_ratio'])} onChange={(e) => set('completion_ratio', toNum(e.target.value))} />
      </Field>
    </div>
  );
}

function ActivityEditor(props: {
  activity: ActivityDto;
  index: number;
  defs: InteractiveDefinitionDto[];
  json: JsonText;
  onJson(key: keyof JsonText, text: string): void;
  update(fn: (a: ActivityDto) => void): void;
  onMove(delta: number): void;
  onRemove(): void;
}) {
  const { activity: a, update } = props;
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  return (
    <div className="activity">
      <div className="row structure-head">
        <span className="muted small">#{props.index + 1}</span>
        <input className="grow" maxLength={200} value={a.title} aria-label="活動名稱" onChange={(e) => update((x) => void (x.title = e.target.value))} />
        <select value={a.activityType} aria-label="活動類型" onChange={(e) => update((x) => void (x.activityType = e.target.value as ActivityType))}>
          {ACTIVITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACTIVITY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={a.isRequired} onChange={(e) => update((x) => void (x.isRequired = e.target.checked))} />
          必修
        </label>
        <Mover onUp={() => props.onMove(-1)} onDown={() => props.onMove(1)} />
        <button type="button" className="btn btn-small btn-danger" onClick={props.onRemove}>
          刪除
        </button>
      </div>
      <div className="form-grid">
        <Field label="互動元件" hint={a.activityType === 'interactive' ? '互動活動必填' : '選填'}>
          <select value={a.interactiveDefinitionId ?? ''} onChange={(e) => update((x) => void (x.interactiveDefinitionId = e.target.value || null))}>
            <option value="">（無）</option>
            {props.defs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.displayName}（{d.componentType}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="作答次數上限" hint="空白表示不限">
          <input type="number" min={1} max={100} value={a.maxAttempts ?? ''} onChange={(e) => update((x) => void (x.maxAttempts = num(e.target.value)))} />
        </Field>
        <Field label="權重">
          <input type="number" min={0} max={999} step="0.1" value={a.weight} onChange={(e) => update((x) => void (x.weight = Number(e.target.value)))} />
        </Field>
        <Field label="滿分">
          <input type="number" min={1} step="1" value={a.maxScore} onChange={(e) => update((x) => void (x.maxScore = Number(e.target.value)))} />
        </Field>
      </div>
      {a.activityType === 'video' && !a.interactiveDefinitionId && <VideoConfigFields text={props.json.config} onChange={(t) => props.onJson('config', t)} />}
      <details>
        <summary className="small">進階：設定、答案與先修條件（JSON）</summary>
        <div className="form-grid">
          <Field label="設定 config">
            <textarea rows={4} spellCheck={false} value={props.json.config} onChange={(e) => props.onJson('config', e.target.value)} />
          </Field>
          <Field label="答案 answerKey" hint="只存在伺服器，學員永遠看不到">
            <textarea rows={4} spellCheck={false} value={props.json.answerKey} onChange={(e) => props.onJson('answerKey', e.target.value)} />
          </Field>
          <Field label="先修條件" hint="完成條件語法；發布前驗證">
            <textarea rows={4} spellCheck={false} value={props.json.prerequisite} onChange={(e) => props.onJson('prerequisite', e.target.value)} />
          </Field>
        </div>
      </details>
    </div>
  );
}

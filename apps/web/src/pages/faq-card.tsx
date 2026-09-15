import {
  FAQ_KINDS,
  FAQ_LIMITS,
  type CommonErrorInsightDto,
  type FaqCitationDto,
  type FaqDraftDto,
  type FaqDto,
  type FaqInsightsDto,
  type FaqKind,
} from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Notice, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi } from '../hooks';
import { issueText } from '../learn-lib';

export const FAQ_KIND_LABELS: Record<FaqKind, string> = { faq: '常見問答', common_error: '常見錯誤' };

interface Draft {
  id: string | null;
  kind: FaqKind;
  question: string;
  answer: string;
  citations: FaqCitationDto[];
  insightKey: string | null;
  learners: number | null;
}

const citeText = (cs: FaqCitationDto[]) => cs.map((c) => `${c.title}${c.pageNo !== null ? ` 第 ${c.pageNo} 頁` : ''}`).join('、');
const errorText = (x: CommonErrorInsightDto) =>
  `「${x.activityTitle}」${issueText({ code: x.code, category: '', severity: 'medium', ...(x.target !== null && { target: x.target }) }, x.targetLabel ?? undefined)}`;

/**
 * 課程頁的「常見問答與常見錯誤」卡片（SD §6.27）：老師撰寫（可請 AI 依教材起草）、編輯（保留舊版）、下架；
 * 以及系統整理的線索（很多學員答錯、很多學員問），一鍵帶入新增表單。
 */
export function FaqCard({ courseId }: { courseId: string }) {
  const me = useMe();
  const canWrite = can(me, 'knowledge.faq.write') && me.licenseCapabilities.authoringAllowed;
  const [showRetired, setShowRetired] = useState(false);
  const list = useApi<FaqDto[]>(`/api/courses/${courseId}/faq${showRetired ? '?includeRetired=true' : ''}`);
  const insights = useApi<FaqInsightsDto>(`/api/courses/${courseId}/faq-insights`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function open(d: Partial<Draft> = {}) {
    setNotice(null);
    setError(null);
    setDraft({ id: null, kind: 'faq', question: '', answer: '', citations: [], insightKey: null, learners: null, ...d });
  }

  async function retire(f: FaqDto) {
    if (!window.confirm(`下架「${f.question}」？學員與 AI 教練將不再看到這一則，紀錄會保留。`)) return;
    setError(null);
    try {
      await api('POST', `/api/courses/${courseId}/faq/${f.id}/retire`);
      list.reload();
      insights.reload();
    } catch (e) {
      setError(e);
    }
  }

  const items = list.data ?? [];
  return (
    <section className="card">
      <h2>常見問答與常見錯誤</h2>
      <p className="muted small">學員在學習頁看得到這些內容；AI 教練回答時會優先引用。可以自己撰寫，也可以從下方「系統整理」的線索建立。</p>
      {notice && <Notice kind="ok">{notice}</Notice>}
      <ErrorAlert error={error ?? list.error} />
      {canWrite && !draft && (
        <button type="button" className="btn btn-primary" onClick={() => open()}>
          新增
        </button>
      )}
      {draft && (
        <FaqEditor
          courseId={courseId}
          draft={draft}
          onCancel={() => setDraft(null)}
          onSaved={(msg) => {
            setDraft(null);
            setNotice(msg);
            list.reload();
            insights.reload();
          }}
        />
      )}
      {!list.data && list.loading && <Spinner />}
      {list.data && items.length === 0 && <p className="muted">還沒有常見問答或常見錯誤。</p>}
      <ul className="faq-list">
        {items.map((f) => (
          <li key={f.id} className={f.status === 'retired' ? 'retired' : undefined}>
            <div className="row">
              <span className={`badge ${f.kind === 'common_error' ? 'badge-grace' : 'badge-active'}`}>{FAQ_KIND_LABELS[f.kind]}</span>
              {f.status === 'retired' && <span className="badge">已下架</span>}
              <strong className="grow">{f.question}</strong>
            </div>
            <p className="faq-answer">{f.answer}</p>
            <div className="muted small">
              v{f.versionNo}・{f.updatedByName ?? '—'}・{formatDateTime(f.updatedAt)}
              {f.source === 'insight' && f.learners !== null && `・由系統整理的線索建立（${f.learners} 位學員）`}
              {f.citations.length > 0 && `・參考教材：${citeText(f.citations)}`}
            </div>
            {canWrite && f.status === 'verified' && (
              <div className="row-actions">
                <button type="button" className="btn btn-small" onClick={() => open({ id: f.id, kind: f.kind, question: f.question, answer: f.answer, citations: f.citations })}>
                  編輯
                </button>
                <button type="button" className="btn btn-small btn-danger" onClick={() => void retire(f)}>
                  下架
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <label className="check small">
        <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
        顯示已下架的
      </label>

      <details className="bulk" open>
        <summary>系統整理：很多學員答錯或詢問的地方</summary>
        <ErrorAlert error={insights.error} />
        {!insights.data && insights.loading && <Spinner />}
        {insights.data && (
          <>
            <p className="muted small">
              近 {insights.data.periodDays} 天的作答結果與 AI 教練提問；至少 {insights.data.threshold} 位學員才會列出，提問已去除姓名、Email、電話與學號。
            </p>
            <h3>很多學員答錯</h3>
            {insights.data.commonErrors.length === 0 ? (
              <p className="muted small">目前沒有達到門檻的錯誤。</p>
            ) : (
              <ul className="link-list">
                {insights.data.commonErrors.map((x) => (
                  <li key={x.key}>
                    {errorText(x)}
                    <span className="muted small">
                      ・{x.learners} 位學員・{x.occurrences} 次
                    </span>{' '}
                    {x.faqId ? (
                      <span className="badge badge-active">已建立</span>
                    ) : (
                      canWrite && (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => open({ kind: 'common_error', question: errorText(x).slice(0, FAQ_LIMITS.question), insightKey: x.key, learners: x.learners })}
                        >
                          寫成常見錯誤
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
            <h3>很多學員問</h3>
            {insights.data.frequentQuestions.length === 0 ? (
              <p className="muted small">目前沒有達到門檻的相似問題。</p>
            ) : (
              <ul className="link-list">
                {insights.data.frequentQuestions.map((x) => (
                  <li key={x.key}>
                    「{x.question}」
                    <span className="muted small">
                      ・{x.learners} 位學員問了 {x.questions} 次
                    </span>{' '}
                    {x.faqId ? (
                      <span className="badge badge-active">已有類似的問答</span>
                    ) : (
                      canWrite && (
                        <button type="button" className="btn btn-small" onClick={() => open({ kind: 'faq', question: x.question.slice(0, FAQ_LIMITS.question), insightKey: x.key, learners: x.learners })}>
                          寫成常見問答
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </details>
    </section>
  );
}

function FaqEditor(props: { courseId: string; draft: Draft; onCancel(): void; onSaved(message: string): void }) {
  const [d, setD] = useState(props.draft);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hint, setHint] = useState<string | null>(null);

  async function askAi() {
    setDrafting(true);
    setError(null);
    setHint(null);
    try {
      const r = await api<FaqDraftDto>('POST', `/api/courses/${props.courseId}/faq/draft`, { kind: d.kind, question: d.question.trim() });
      if (r.status === 'drafted') {
        setD({ ...d, answer: r.answer, citations: r.citations });
        setHint('AI 已依教材起草，請檢查、修改後再儲存。');
      } else {
        setHint('教材中找不到足夠的資料，AI 無法起草；請自行撰寫。');
      }
    } catch (e) {
      setError(e);
    } finally {
      setDrafting(false);
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { question: d.question.trim(), answer: d.answer.trim(), citations: d.citations };
      if (d.id) await api('PATCH', `/api/courses/${props.courseId}/faq/${d.id}`, body);
      else await api('POST', `/api/courses/${props.courseId}/faq`, { ...body, kind: d.kind, insightKey: d.insightKey, learners: d.learners });
      props.onSaved(d.id ? '已更新（舊版本會保留）。' : '已新增，學員與 AI 教練現在看得到。');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="editor form-grid" onSubmit={(e) => void save(e)}>
      <fieldset disabled={busy}>
        {!d.id && (
          <Field label="類型">
            <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as FaqKind })}>
              {FAQ_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FAQ_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={d.kind === 'faq' ? '問題' : '常見錯誤'}>
          <input required minLength={2} maxLength={FAQ_LIMITS.question} value={d.question} onChange={(e) => setD({ ...d, question: e.target.value })} />
        </Field>
        <Field label={d.kind === 'faq' ? '回答' : '說明與改正方法'} hint="不要寫入學員的姓名或個人資料">
          <textarea required rows={5} maxLength={FAQ_LIMITS.answer} value={d.answer} onChange={(e) => setD({ ...d, answer: e.target.value })} />
        </Field>
        {d.citations.length > 0 && <p className="muted small">參考教材：{citeText(d.citations)}</p>}
        {hint && <Notice kind="info">{hint}</Notice>}
        <ErrorAlert error={error} />
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {busy ? '儲存中…' : '儲存'}
          </button>
          <button type="button" className="btn" disabled={drafting || d.question.trim().length < 2} onClick={() => void askAi()}>
            {drafting ? 'AI 起草中…' : '請 AI 起草'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
            取消
          </button>
        </div>
      </fieldset>
    </form>
  );
}

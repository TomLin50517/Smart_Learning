import type { CompletionApprovalDto, EnrollmentStatus, LearnerProgressDto, RelearningResultDto, RelearningScope } from '@iac/contracts';
import { Fragment, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import {
  ACTIVITY_STATE_LABELS,
  ACTIVITY_TYPE_LABELS,
  ENROLLMENT_STATUS_BADGE,
  ENROLLMENT_STATUS_LABELS,
  formatDateTime,
  RESULT_STATUS_LABELS,
  ROLE_LABELS,
} from '../format';
import { useApi, useTitle } from '../hooks';
import { relearningScopeText } from '../learn-lib';
import { ProgressCard } from './LearnPage';
import { TimelineView } from './timeline-view';

/**
 * /app/courses/:courseId/learners/:enrollmentId：課程人員檢視單一學員（SD §6.13）——
 * 進度與未完成原因、各活動狀態／成績／次數／影片觀看比例、學習時間與學習歷程。
 */
export function LearnerDetailPage() {
  const { courseId = '', enrollmentId = '' } = useParams();
  const me = useMe();
  const allowed = can(me, 'learning.result.read_all');
  const p = useApi<LearnerProgressDto>(allowed ? `/api/enrollments/${enrollmentId}/progress` : null);
  useTitle(p.data ? `${p.data.learner.displayName} 的學習狀況` : '學習狀況');

  if (!allowed) return <Forbidden />;
  if (!p.data) return p.loading ? <Spinner /> : <ErrorAlert error={p.error} />;
  const d = p.data;
  const titleOf = (id: string) => d.modules.flatMap((m) => m.lessons.flatMap((l) => l.activities)).find((a) => a.id === id)?.title;

  return (
    <>
      <PageHeader
        title={d.learner.displayName}
        subtitle={
          <>
            {d.learner.memberNo && <>學號 {d.learner.memberNo}・</>}
            {d.learner.cohortLabel && <>{d.learner.cohortLabel}・</>}
            {d.learner.email}・{d.enrollment.courseTitle}（v{d.enrollment.versionNo}）{' '}
            <span className={`badge ${ENROLLMENT_STATUS_BADGE[d.enrollment.status]}`}>{ENROLLMENT_STATUS_LABELS[d.enrollment.status]}</span>
          </>
        }
        actions={<Link to={`/app/courses/${courseId}`}>← 回到課程</Link>}
      />
      <ProgressCard progress={d.progress} titleOf={titleOf} />
      {d.approval.required.length > 0 && <ApprovalCard enrollmentId={enrollmentId} approval={d.approval} canLearn={d.enrollment.canLearn} onDone={p.reload} />}
      {(can(me, 'enrollment.relearning.assign') || can(me, 'enrollment.reopen') || d.relearnings.length > 0) && (
        <RelearningCard data={d} enrollmentId={enrollmentId} onDone={p.reload} />
      )}

      <section className="card">
        <h2>各活動</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>活動</th>
                <th>狀態</th>
                <th>最佳結果</th>
                <th>作答次數</th>
                <th>影片觀看</th>
              </tr>
            </thead>
            <tbody>
              {d.modules.map((m, mi) => (
                <Fragment key={m.id}>
                  <tr className="group-row">
                    <th colSpan={5}>
                      {mi + 1}. {m.title}
                    </th>
                  </tr>
                  {m.lessons
                    .flatMap((l) => l.activities)
                    .map((a) => (
                      <tr key={a.id}>
                        <td>
                          {a.title}
                          <div className="muted small">
                            {ACTIVITY_TYPE_LABELS[a.activityType]}
                            {a.isRequired ? '・必修' : '・選修'}
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${a.state === 'completed' ? 'badge-active' : a.state === 'locked' ? '' : 'badge-grace'}`}>{ACTIVITY_STATE_LABELS[a.state]}</span>
                          {a.inRelearning && <span className="badge badge-grace"> 🔁 重修</span>}
                        </td>
                        <td>
                          {a.best ? (
                            <>
                              {RESULT_STATUS_LABELS[a.best.status]}
                              {a.best.score !== null && `（${a.best.score}／${a.best.maxScore}）`}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {a.attempts}
                          {a.maxAttempts !== null && `／${a.maxAttempts}`}
                        </td>
                        <td>{a.watchedRatio === null ? <span className="muted">—</span> : `${Math.round(a.watchedRatio * 100)}%`}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>學習歷程</h2>
        {can(me, 'learning.timeline.read_all') ? <TimelineView path={`/api/enrollments/${enrollmentId}/timeline`} /> : <p className="muted">你沒有檢視學習歷程的權限。</p>}
      </section>
    </>
  );
}

const roleText = (r: string) => (ROLE_LABELS as Record<string, string>)[r] ?? r;

const RELEARNABLE: readonly EnrollmentStatus[] = ['active', 'reopened', 'completed'];

/**
 * 重修與重新開啟（SD §6.25）：歷史清單、指派重修（範圍、原因、期限、作答次數）、只重新開啟。
 * 之前的作答與成績一律保留；範圍內的活動只採計重修之後的結果。
 */
function RelearningCard({ data: d, enrollmentId, onDone }: { data: LearnerProgressDto; enrollmentId: string; onDone(): void }) {
  const me = useMe();
  const canAssign = can(me, 'enrollment.relearning.assign');
  const canReopen = can(me, 'enrollment.reopen');
  // 範圍的值："course" 或 "module:<id>"／"lesson:<id>"／"activity:<id>"
  const [scope, setScope] = useState('course');
  const [reason, setReason] = useState('');
  const [due, setDue] = useState('');
  const [keepCount, setKeepCount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = d.enrollment.status;
  const assignable = RELEARNABLE.includes(status);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      setReason('');
      setDue('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const [scopeType, scopeId] = scope.split(':') as [RelearningScope, string | undefined];
    if (!window.confirm(`指派重修給「${d.learner.displayName}」？範圍內的活動需要重新完成，之前的作答與成績會保留在學習歷程中。`)) return;
    void run(async () => {
      const r = await api<RelearningResultDto>('POST', `/api/enrollments/${enrollmentId}/relearning`, {
        scopeType,
        scopeId: scopeId ?? null,
        reason: reason.trim(),
        dueDate: due ? new Date(`${due}T23:59:59`).toISOString() : null,
        newAttemptPolicy: keepCount ? 'append' : 'reset_counter',
      });
      return status === 'completed' ? `已指派重修（${relearningScopeText(r.relearning)}），課程已重新開啟。` : `已指派重修（${relearningScopeText(r.relearning)}）。`;
    });
  }

  function reopen() {
    if (!window.confirm('重新開啟這門課？成績照舊，學員可以繼續練習；再次符合完成條件時會回到「已完成」（證書不會重發）。')) return;
    void run(async () => {
      await api('POST', `/api/enrollments/${enrollmentId}/reopen`, reason.trim() ? { reason: reason.trim() } : {});
      return '已重新開啟課程。';
    });
  }

  return (
    <section className="card">
      <h2>重修與重新開啟</h2>
      {d.relearnings.length > 0 && (
        <ul className="small">
          {d.relearnings.map((r) => (
            <li key={r.id}>
              {formatDateTime(r.assignedAt)}・{relearningScopeText(r)}・{r.assignedByName}：{r.reason}
              {r.dueDate && `（期限 ${formatDateTime(r.dueDate)}）`}
              {r.newAttemptPolicy === 'append' && '・沿用作答次數'}
            </li>
          ))}
        </ul>
      )}
      {notice && <Notice kind="ok">{notice}</Notice>}
      <ErrorAlert error={error} />
      {canAssign && assignable && (
        <form className="form-grid" onSubmit={assign}>
          <fieldset disabled={busy}>
            <Field label="重修範圍" hint="範圍內的活動需要重新完成；作答次數預設從這次重修重新計算">
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="course">整門課</option>
                {d.modules.map((m, mi) => (
                  <Fragment key={m.id}>
                    <option value={`module:${m.id}`}>
                      {mi + 1}. {m.title}（整個單元）
                    </option>
                    {m.lessons.map((l) => (
                      <Fragment key={l.id}>
                        <option value={`lesson:${l.id}`}>　{l.title}（整個課節）</option>
                        {l.activities.map((a) => (
                          <option key={a.id} value={`activity:${a.id}`}>
                            　　{a.title}
                          </option>
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </select>
            </Field>
            <Field label="原因" hint="學員看得到">
              <textarea required rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field label="新的完成期限（選填）">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={keepCount} onChange={(e) => setKeepCount(e.target.checked)} />
              沿用已用的作答次數（有次數上限的活動可能無法再作答）
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                {busy ? '處理中…' : '指派重修'}
              </button>
              {canReopen && status === 'completed' && (
                <button type="button" className="btn" onClick={reopen}>
                  只重新開啟（成績照舊）
                </button>
              )}
            </div>
          </fieldset>
        </form>
      )}
      {!assignable && <p className="muted small">目前的選課狀態（{ENROLLMENT_STATUS_LABELS[status]}）無法重修或重新開啟。</p>}
    </section>
  );
}

/**
 * 人工核可（SD §6.14）：完成條件要求的核可者與目前狀態。按鈕顯示給課程人員，
 * 實際能否核可由伺服器依完成條件指定的角色判斷（不是指定角色會看到錯誤說明）。
 */
function ApprovalCard(props: { enrollmentId: string; approval: LearnerProgressDto['approval']; canLearn: boolean; onDone(): void }) {
  const { approval } = props;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = approval.required.filter((r) => !approval.given.some((g) => g.approverRole === r));

  async function approve() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api<CompletionApprovalDto>('POST', `/api/enrollments/${props.enrollmentId}/completion-approvals`, note.trim() ? { note: note.trim() } : {});
      setNotice(r.completionChanged ? '已核可。學員已完成課程，系統會自動發出證書。' : '已核可。學員完成其他條件後即完成課程。');
      setNote('');
      props.onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>人工核可</h2>
      <ul className="small">
        {approval.required.map((r) => {
          const g = approval.given.find((x) => x.approverRole === r);
          return (
            <li key={r}>
              {roleText(r)}：
              {g ? (
                <>
                  已由 {g.approverName} 於 {formatDateTime(g.approvedAt)} 核可{g.note && `（${g.note}）`}
                </>
              ) : (
                <span className="text-danger">尚未核可</span>
              )}
            </li>
          );
        })}
      </ul>
      {notice && <Notice kind="ok">{notice}</Notice>}
      <ErrorAlert error={error} />
      {pending.length > 0 && props.canLearn && (
        <div className="stack">
          <Field label="備註（選填）" hint="會記錄在稽核紀錄中">
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void approve()}>
              {busy ? '處理中…' : '核可完成'}
            </button>
          </div>
          <p className="muted small">需由擔任「{pending.map(roleText).join('、')}」的人員核可。</p>
        </div>
      )}
    </section>
  );
}

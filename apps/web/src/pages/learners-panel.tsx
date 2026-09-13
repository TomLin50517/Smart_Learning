import { ENROLLMENT_STATUSES, type CohortDto, type CourseDetailDto, type CourseLearnerDto, type EnrollmentStatus, type ImportReportDto } from '@iac/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Notice } from '../components/ui';
import { ENROLLMENT_STATUS_BADGE, ENROLLMENT_STATUS_LABELS, formatDate, formatDateTime } from '../format';
import { useApi } from '../hooks';
import { BulkImportCard, ImportReportView } from './bulk-import';

interface Page {
  data: CourseLearnerDto[];
  /** cohorts：本課程出現過的班級（選課時的快照），供篩選 */
  meta: { next_cursor: string | null; cohorts: string[] };
}

const SEARCH_DELAY_MS = 300;

/** 課程頁的「學員」卡片：名單（學號、選課時的班級、進度）、指派入課、整班加入、暫停／恢復／退課（SD §6.8、§6.15） */
export function LearnersPanel({ course }: { course: CourseDetailDto }) {
  const me = useMe();
  const [statusFilter, setStatusFilter] = useState<EnrollmentStatus | ''>('');
  const [cohortFilter, setCohortFilter] = useState('');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [text]);
  const qs = new URLSearchParams({ limit: '100' });
  if (statusFilter) qs.set('status', statusFilter);
  if (cohortFilter) qs.set('cohort', cohortFilter);
  if (search) qs.set('q', search);
  const list = useApi<Page>(`/api/courses/${course.id}/learners?${qs.toString()}`);
  const [email, setEmail] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canAssign = can(me, 'enrollment.assign');
  const canSuspend = can(me, 'enrollment.suspend');
  const canWithdraw = can(me, 'enrollment.withdraw');
  const assignable = !!course.publishedVersion && course.status !== 'archived';
  const filtered = statusFilter !== '' || cohortFilter !== '' || search !== '';

  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const addr = email.trim();
      await api('POST', `/api/courses/${course.id}/enrollments`, {
        email: addr,
        ...(due && { dueDate: new Date(`${due}T23:59:59`).toISOString() }),
      });
      setNotice(`已將 ${addr} 加入課程（v${course.publishedVersion?.versionNo}）。`);
      setEmail('');
      setDue('');
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function change(l: CourseLearnerDto, action: 'suspend' | 'resume' | 'withdraw') {
    if (action === 'withdraw' && !window.confirm(`確定讓「${l.displayName}」退課？學習紀錄會保留，之後可以重新指派。`)) return;
    setError(null);
    setNotice(null);
    try {
      await api('POST', `/api/enrollments/${l.id}/${action}`);
      list.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="card">
      <h2>學員</h2>
      {!course.publishedVersion && <Notice kind="info">課程尚未發布；發布後才能加入學員。</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}
      <ErrorAlert error={error} />
      <ErrorAlert error={list.error} />

      {canAssign && assignable && (
        <form className="form-grid" onSubmit={(e) => void assign(e)}>
          <fieldset disabled={busy}>
            <Field label="學員 Email" hint="須為本組織的成員；尚無學員身分者會自動加上">
              <input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="完成期限（選填）">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                {busy ? '加入中…' : '加入課程'}
              </button>
            </div>
          </fieldset>
        </form>
      )}

      {canAssign && assignable && (
        <details className="bulk">
          <summary>整班加入</summary>
          <CohortEnroll courseId={course.id} onDone={() => list.reload()} />
        </details>
      )}

      {canAssign && assignable && (
        <details className="bulk">
          <summary>批次加入學員</summary>
          <BulkImportCard kind="learners" endpoint={`/api/courses/${course.id}/enrollments/import`} onDone={() => list.reload()} />
        </details>
      )}

      <div className="toolbar">
        <input type="search" placeholder="搜尋姓名、Email 或學號" aria-label="搜尋學員" maxLength={100} value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="依班級篩選" value={cohortFilter} onChange={(e) => setCohortFilter(e.target.value)}>
          <option value="">全部班級</option>
          {(list.data?.meta.cohorts ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select aria-label="依狀態篩選" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as EnrollmentStatus | '')}>
          <option value="">全部狀態</option>
          {ENROLLMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ENROLLMENT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>學員</th>
              <th title="選課時所在的班級">班級</th>
              <th>狀態</th>
              <th>進度</th>
              <th>最後學習</th>
              <th>版本</th>
              <th>期限</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((l) => (
              <tr key={l.id}>
                <td>
                  <div>
                    <Link to={`/app/courses/${course.id}/learners/${l.id}`}>{l.displayName}</Link>
                    {l.memberDisabled && <span className="badge badge-blocked"> 成員已停用</span>}
                  </div>
                  <div className="muted small">
                    {l.memberNo && <>{l.memberNo}・</>}
                    {l.email}
                  </div>
                </td>
                <td>{l.cohortLabel ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${ENROLLMENT_STATUS_BADGE[l.status]}`}>{ENROLLMENT_STATUS_LABELS[l.status]}</span>
                </td>
                <td>
                  {l.progress ? (
                    <>
                      {l.progress.requiredCompleted}／{l.progress.requiredTotal}
                      {l.progress.weightedScore !== null && <div className="muted small">{l.progress.weightedScore} 分</div>}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="small">{formatDateTime(l.lastActivityAt)}</td>
                <td>v{l.versionNo}</td>
                <td>{formatDate(l.dueDate)}</td>
                <td className="actions">
                  <div className="row-actions">
                    {canSuspend && (l.status === 'active' || l.status === 'reopened') && (
                      <button type="button" className="btn btn-small" onClick={() => void change(l, 'suspend')}>
                        暫停
                      </button>
                    )}
                    {canSuspend && l.status === 'suspended' && (
                      <button type="button" className="btn btn-small" onClick={() => void change(l, 'resume')}>
                        恢復
                      </button>
                    )}
                    {canWithdraw && ['pending', 'active', 'suspended', 'reopened'].includes(l.status) && (
                      <button type="button" className="btn btn-small btn-danger" onClick={() => void change(l, 'withdraw')}>
                        退課
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data && list.data.data.length === 0 && <p className="muted">{filtered ? '沒有符合條件的學員。' : '尚未有學員。'}</p>}
      {list.data?.meta.next_cursor && <p className="muted small">僅顯示前 100 位，請用搜尋或篩選縮小範圍。</p>}
    </section>
  );
}

/** 整班加入（SD §6.15）：選擇組織的班級 → 預覽 → 確認。已在課程中的人會略過 */
function CohortEnroll({ courseId, onDone }: { courseId: string; onDone(): void }) {
  const cohorts = useApi<CohortDto[]>(`/api/courses/${courseId}/cohorts`);
  const [cohortId, setCohortId] = useState('');
  const [report, setReport] = useState<ImportReportDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function send(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportReportDto>('POST', `/api/courses/${courseId}/enrollments/cohort`, { dryRun, cohortId });
      setReport(r);
      if (!dryRun) onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const canConfirm = !!report?.dryRun && report.summary.ok > 0 && report.license.exceededBy === 0;

  return (
    <div className="bulk-import">
      <p className="muted small">把班級目前的成員一次加入這門課：先預覽，確認後才加入；已在課程中的人會略過。</p>
      <ErrorAlert error={cohorts.error} />
      {cohorts.data && cohorts.data.length === 0 ? (
        <p className="muted">組織尚未建立班級（由組織管理員在「班級管理」建立）。</p>
      ) : (
        <div className="row">
          <select
            aria-label="選擇班級"
            value={cohortId}
            onChange={(e) => {
              setCohortId(e.target.value);
              setReport(null);
            }}
          >
            <option value="">選擇班級…</option>
            {(cohorts.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.term ? `（${c.term}）` : ''}・{c.memberCount} 人
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={busy || !cohortId} onClick={() => void send(true)}>
            預覽
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !canConfirm} onClick={() => void send(false)}>
            {`確認加入${report?.dryRun ? `（${report.summary.ok} 人）` : ''}`}
          </button>
        </div>
      )}
      <ErrorAlert error={error} />
      {report && <ImportReportView report={report} />}
    </div>
  );
}

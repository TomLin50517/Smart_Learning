import { ENROLLMENT_STATUSES, type CourseDetailDto, type CourseLearnerDto, type EnrollmentStatus } from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Notice } from '../components/ui';
import { ENROLLMENT_STATUS_BADGE, ENROLLMENT_STATUS_LABELS, formatDate } from '../format';
import { useApi } from '../hooks';

interface Page {
  data: CourseLearnerDto[];
  meta: { next_cursor: string | null };
}

/** 課程頁的「學員」卡片：名單、指派入課、暫停／恢復／退課（SD §6.8） */
export function LearnersPanel({ course }: { course: CourseDetailDto }) {
  const me = useMe();
  const [statusFilter, setStatusFilter] = useState<EnrollmentStatus | ''>('');
  const list = useApi<Page>(`/api/courses/${course.id}/learners?limit=100${statusFilter ? `&status=${statusFilter}` : ''}`);
  const [email, setEmail] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canAssign = can(me, 'enrollment.assign');
  const canSuspend = can(me, 'enrollment.suspend');
  const canWithdraw = can(me, 'enrollment.withdraw');
  const assignable = !!course.publishedVersion && course.status !== 'archived';

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

      <div className="toolbar">
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
              <th>狀態</th>
              <th>版本</th>
              <th>加入</th>
              <th>期限</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((l) => (
              <tr key={l.id}>
                <td>
                  <div>
                    {l.displayName}
                    {l.memberDisabled && <span className="badge badge-blocked"> 成員已停用</span>}
                  </div>
                  <div className="muted small">{l.email}</div>
                </td>
                <td>
                  <span className={`badge ${ENROLLMENT_STATUS_BADGE[l.status]}`}>{ENROLLMENT_STATUS_LABELS[l.status]}</span>
                </td>
                <td>v{l.versionNo}</td>
                <td>{formatDate(l.enrolledAt)}</td>
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
      {list.data && list.data.data.length === 0 && <p className="muted">{statusFilter ? '沒有符合條件的學員。' : '尚未有學員。'}</p>}
      {list.data?.meta.next_cursor && <p className="muted small">僅顯示前 100 位。</p>}
    </section>
  );
}

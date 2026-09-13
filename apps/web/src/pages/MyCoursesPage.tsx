import type { MyEnrollmentDto } from '@iac/contracts';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, PageHeader, Spinner } from '../components/ui';
import { ENROLLMENT_STATUS_BADGE, ENROLLMENT_STATUS_LABELS, formatDate } from '../format';
import { useApi, useTitle } from '../hooks';

/** /app/learn：學員的「我的課程」（UC-ENR-010） */
export function MyCoursesPage() {
  useTitle('我的課程');
  const me = useMe();
  const allowed = can(me, 'learning.result.read_self');
  const list = useApi<MyEnrollmentDto[]>(allowed ? '/api/me/enrollments' : null);

  if (!allowed) return <Forbidden />;
  const multiOrg = new Set((list.data ?? []).map((e) => e.organizationId)).size > 1;

  return (
    <>
      <PageHeader title="我的課程" subtitle="被指派或加入的課程。學習畫面將於下一階段開放。" />
      <ErrorAlert error={list.error} />
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.length === 0 && (
        <section className="card">
          <p className="muted">目前沒有課程。老師或管理員指派課程後會出現在這裡。</p>
        </section>
      )}
      <div className="card-grid">
        {(list.data ?? []).map((e) => (
          <section key={e.id} className="card">
            <p className="muted small">
              <code>{e.course.code}</code>
              {multiOrg && <>・{e.organizationName}</>}
            </p>
            <h2>{e.course.title}</h2>
            <p>
              <span className={`badge ${ENROLLMENT_STATUS_BADGE[e.status]}`}>{ENROLLMENT_STATUS_LABELS[e.status]}</span>{' '}
              <span className="muted small">v{e.versionNo}</span>
            </p>
            <p className="muted small">
              加入：{formatDate(e.enrolledAt)}
              {e.dueDate && <>・期限：{formatDate(e.dueDate)}</>}
              {e.completedAt && <>・完成：{formatDate(e.completedAt)}</>}
            </p>
            <button type="button" className="btn btn-primary" disabled title="學習畫面將於下一階段開放">
              {e.canLearn ? '進入課程（即將開放）' : '目前無法學習'}
            </button>
          </section>
        ))}
      </div>
    </>
  );
}

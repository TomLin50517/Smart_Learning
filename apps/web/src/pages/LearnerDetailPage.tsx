import type { LearnerProgressDto } from '@iac/contracts';
import { Fragment } from 'react';
import { Link, useParams } from 'react-router';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, PageHeader, Spinner } from '../components/ui';
import { ACTIVITY_STATE_LABELS, ACTIVITY_TYPE_LABELS, ENROLLMENT_STATUS_BADGE, ENROLLMENT_STATUS_LABELS, RESULT_STATUS_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';
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
            {d.learner.email}・{d.enrollment.courseTitle}（v{d.enrollment.versionNo}）{' '}
            <span className={`badge ${ENROLLMENT_STATUS_BADGE[d.enrollment.status]}`}>{ENROLLMENT_STATUS_LABELS[d.enrollment.status]}</span>
          </>
        }
        actions={<Link to={`/app/courses/${courseId}`}>← 回到課程</Link>}
      />
      <ProgressCard progress={d.progress} titleOf={titleOf} />

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

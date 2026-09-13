import type { LearnerOutlineDto } from '@iac/contracts';
import { Link, useParams } from 'react-router';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { Forbidden, PageHeader } from '../components/ui';
import { useApi, useTitle } from '../hooks';
import { TimelineView } from './timeline-view';

/** /app/learn/:enrollmentId/timeline：學員自己的學習歷程（SD §6.13） */
export function MyTimelinePage() {
  const { enrollmentId = '' } = useParams();
  const me = useMe();
  const allowed = can(me, 'learning.timeline.read_self');
  // 只用來顯示課程名稱
  const outline = useApi<LearnerOutlineDto>(allowed && can(me, 'learning.result.read_self') ? `/api/enrollments/${enrollmentId}/outline` : null);
  useTitle('學習歷程');

  if (!allowed) return <Forbidden />;
  return (
    <>
      <PageHeader title="學習歷程" subtitle={outline.data?.enrollment.courseTitle} actions={<Link to={`/app/learn/${enrollmentId}`}>← 回到課程</Link>} />
      <section className="card">
        <TimelineView path={`/api/me/enrollments/${enrollmentId}/timeline`} />
      </section>
    </>
  );
}

import type { LearnerOutlineDto, LessonBlock, OutlineActivityDto, ProgressDto } from '@iac/contracts';
import { Link, useParams, useSearchParams } from 'react-router';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { ACTIVITY_STATE_ICONS, ENROLLMENT_STATUS_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';
import { blockingReasonText, parseMarkdownLite } from '../learn-lib';
import { ActivityPanel } from './activity-panel';

type Lesson = LearnerOutlineDto['modules'][number]['lessons'][number];

/** /app/learn/:enrollmentId：學員的課程播放頁——左側大綱、右側課節內容與活動、上方進度（SD §6.10） */
export function LearnPage() {
  const { enrollmentId = '' } = useParams();
  const me = useMe();
  const allowed = can(me, 'learning.result.read_self');
  const outline = useApi<LearnerOutlineDto>(allowed ? `/api/enrollments/${enrollmentId}/outline` : null);
  const [params, setParams] = useSearchParams();
  useTitle(outline.data?.enrollment.courseTitle ?? '學習');

  if (!allowed) return <Forbidden />;
  if (!outline.data) return outline.loading ? <Spinner /> : <ErrorAlert error={outline.error} />;
  const o = outline.data;

  const lessons = o.modules.flatMap((m) => m.lessons);
  const allActivities = lessons.flatMap((l) => l.activities);
  const titleOf = (id: string) => allActivities.find((a) => a.id === id)?.title;
  const picked = params.get('lesson');
  // 預設打開第一個還有事可做的課節
  const current =
    lessons.find((l) => l.id === picked) ??
    lessons.find((l) => l.activities.some((a) => a.state === 'available' || a.state === 'in_progress' || a.state === 'attempted')) ??
    lessons[0];

  return (
    <>
      <PageHeader
        title={o.enrollment.courseTitle}
        subtitle={`v${o.enrollment.versionNo}・${ENROLLMENT_STATUS_LABELS[o.enrollment.status]}`}
        actions={<Link to="/app/learn">← 我的課程</Link>}
      />
      <ProgressCard progress={o.progress} titleOf={titleOf} />
      {!o.enrollment.canLearn && o.enrollment.status !== 'completed' && (
        <Notice kind="warn">目前的選課狀態（{ENROLLMENT_STATUS_LABELS[o.enrollment.status]}）無法作答，只能瀏覽內容。</Notice>
      )}
      {o.enrollment.status === 'completed' && <Notice kind="ok">你已完成這門課程，現在是回顧模式。</Notice>}

      <div className="player">
        <nav className="card outline" aria-label="課程大綱">
          {o.modules.map((m, mi) => (
            <div key={m.id}>
              <h3>
                {mi + 1}. {m.title}
                {!m.isRequired && <span className="muted small">（選修）</span>}
              </h3>
              <ul>
                {m.lessons.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      className="lesson-link"
                      aria-current={l.id === current?.id}
                      onClick={() => setParams({ lesson: l.id }, { replace: true })}
                    >
                      <span>{l.title}</span>
                      <span className="state-icons" aria-label={l.activities.map((a) => `${a.title}：${a.state}`).join('、')}>
                        {l.activities.map((a) => ACTIVITY_STATE_ICONS[a.state]).join('')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {lessons.length === 0 && <p className="muted">這門課還沒有內容。</p>}
        </nav>

        <div className="lesson-pane">
          {current ? (
            <LessonView key={current.id} lesson={current} canLearn={o.enrollment.canLearn} onChanged={outline.reload} />
          ) : (
            <section className="card">
              <p className="muted">這門課還沒有內容。</p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function ProgressCard({ progress: p, titleOf }: { progress: ProgressDto; titleOf(id: string): string | undefined }) {
  const pct = p.requiredTotal ? Math.round((p.requiredCompleted / p.requiredTotal) * 100) : 0;
  return (
    <section className="card">
      <div className="row structure-head">
        <strong className="grow">
          必修活動 {p.requiredCompleted}／{p.requiredTotal}
          {p.weightedScore !== null && <span className="muted small">・目前總分 {p.weightedScore}</span>}
        </strong>
        {p.completed && <span className="badge badge-active">已達完成條件</span>}
      </div>
      <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {!p.completed && p.blockingReasons.length > 0 && (
        <details>
          <summary className="small">還差什麼？</summary>
          <ul className="small">
            {p.blockingReasons.map((r, i) => (
              <li key={i}>{blockingReasonText(r, titleOf)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function LessonView({ lesson, canLearn, onChanged }: { lesson: Lesson; canLearn: boolean; onChanged(): void }) {
  const byId = new Map<string, OutlineActivityDto>(lesson.activities.map((a) => [a.id, a]));
  const placed = new Set(lesson.contentBlocks.filter((b) => b.type === 'activity').map((b) => (b as { activityId: string }).activityId));
  const rest = lesson.activities.filter((a) => !placed.has(a.id));
  return (
    <section className="card lesson-content">
      <h2>{lesson.title}</h2>
      {lesson.contentBlocks.map((b, i) => (
        <Block key={i} block={b} activity={b.type === 'activity' ? byId.get(b.activityId) : undefined} canLearn={canLearn} onChanged={onChanged} />
      ))}
      {rest.length > 0 && (
        <>
          {lesson.contentBlocks.length > 0 && <h3>活動</h3>}
          {rest.map((a) => (
            <ActivityPanel key={a.id} activity={a} canLearn={canLearn} onChanged={onChanged} />
          ))}
        </>
      )}
      {lesson.contentBlocks.length === 0 && lesson.activities.length === 0 && <p className="muted">這個課節還沒有內容。</p>}
    </section>
  );
}

function Block(props: { block: LessonBlock; activity: OutlineActivityDto | undefined; canLearn: boolean; onChanged(): void }) {
  const b = props.block;
  switch (b.type) {
    case 'richtext':
      return (
        <div className="richtext">
          {parseMarkdownLite(b.markdown).map((m, i) =>
            m.type === 'h' ? (
              m.level === 1 ? (
                <h3 key={i}>{m.text}</h3>
              ) : (
                <h4 key={i}>{m.text}</h4>
              )
            ) : m.type === 'ul' ? (
              <ul key={i}>
                {m.items.map((x, j) => (
                  <li key={j}>{x}</li>
                ))}
              </ul>
            ) : (
              <p key={i} className="pre-line">
                {m.text}
              </p>
            ),
          )}
        </div>
      );
    case 'callout':
      return <Notice kind={b.variant === 'warning' ? 'warn' : b.variant === 'success' ? 'ok' : 'info'}>{b.body}</Notice>;
    case 'activity':
      return props.activity ? <ActivityPanel activity={props.activity} canLearn={props.canLearn} onChanged={props.onChanged} /> : null;
    case 'image':
    case 'video':
      return <p className="muted small">（{b.type === 'image' ? '圖片' : '影片'}素材將於素材管理上線後顯示）</p>;
  }
}

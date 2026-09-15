import { assetUrl, COACH_HIDDEN_REASONS, type CoachAvailabilityDto, type LearnerOutlineDto, type LearningTimeDto, type LessonBlock, type OutlineActivityDto, type ProgressDto } from '@iac/contracts';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { ACTIVITY_STATE_ICONS, ENROLLMENT_STATUS_LABELS, formatDateTime, formatMinutes } from '../format';
import { useApi, useTitle } from '../hooks';
import { blockingReasonText, parseMarkdownLite, relearningScopeText } from '../learn-lib';
import { ActivityPanel } from './activity-panel';
import { CoachPanel } from './coach-panel';

type Lesson = LearnerOutlineDto['modules'][number]['lessons'][number];

/** /app/learn/:enrollmentId：學員的課程播放頁——左側大綱、右側課節內容與活動、上方進度（SD §6.10） */
export function LearnPage() {
  const { enrollmentId = '' } = useParams();
  const me = useMe();
  const allowed = can(me, 'learning.result.read_self');
  const outline = useApi<LearnerOutlineDto>(allowed ? `/api/enrollments/${enrollmentId}/outline` : null);
  // AI 教練：設定面無法使用（沒金鑰、組織停用、授權不含…）時學員畫面直接隱藏；暫時性的保留並顯示「休息中」（SD §6.22）
  const coachAv = useApi<CoachAvailabilityDto>(
    can(me, 'coach.conversation.read_self') && me.licenseCapabilities.aiCoachAllowed ? `/api/enrollments/${enrollmentId}/coach` : null,
  );
  const [params, setParams] = useSearchParams();
  // 結果旁「請 AI 教練看看」：交給右側教練對話處理（nonce 讓同一個作答可再按一次）
  const [coachResult, setCoachResult] = useState<{ attemptId: string; nonce: number } | null>(null);
  useTitle(outline.data?.enrollment.courseTitle ?? '學習');

  if (!allowed) return <Forbidden />;
  if (!outline.data) return outline.loading ? <Spinner /> : <ErrorAlert error={outline.error} />;
  const o = outline.data;

  const coachReason = coachAv.data?.reason ?? null;
  const coachShown = !!coachAv.data && !(coachReason && COACH_HIDDEN_REASONS.includes(coachReason));
  const askCoach =
    coachShown && coachAv.data?.available && can(me, 'coach.interact_self') ? (attemptId: string) => setCoachResult({ attemptId, nonce: Date.now() }) : undefined;
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
        actions={
          <>
            {can(me, 'learning.timeline.read_self') && <Link to={`/app/learn/${enrollmentId}/timeline`}>學習歷程</Link>}
            <Link to="/app/learn">← 我的課程</Link>
          </>
        }
      />
      <ProgressCard progress={o.progress} time={o.time} titleOf={titleOf} />
      {!o.enrollment.canLearn && o.enrollment.status !== 'completed' && (
        <Notice kind="warn">目前的選課狀態（{ENROLLMENT_STATUS_LABELS[o.enrollment.status]}）無法作答，只能瀏覽內容。</Notice>
      )}
      {o.enrollment.status === 'completed' && (
        <Notice kind="ok">
          你已完成這門課程，現在是回顧模式。{can(me, 'certificate.read_self') && <Link to="/app/certificates">查看我的證書</Link>}
        </Notice>
      )}
      {o.relearning && (
        <Notice kind="info">
          老師指派了重修（{relearningScopeText(o.relearning)}）：{o.relearning.reason}
          {o.relearning.dueDate && `　期限：${formatDateTime(o.relearning.dueDate)}`}
          。標示 🔁 的活動需要重新完成；之前的作答與成績仍保留在學習歷程中。
        </Notice>
      )}
      {o.enrollment.status === 'reopened' && !o.relearning && <Notice kind="info">課程已重新開啟，可以繼續練習；成績採計最好的一次。</Notice>}

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
                        {l.activities.some((a) => a.inRelearning) && ' 🔁'}
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
            <LessonView key={current.id} lesson={current} canLearn={o.enrollment.canLearn} onChanged={outline.reload} onAskCoach={askCoach} />
          ) : (
            <section className="card">
              <p className="muted">這門課還沒有內容。</p>
            </section>
          )}
        </div>
      </div>
      {coachShown && <CoachPanel enrollmentId={enrollmentId} activityId={current?.activities[0]?.id} contextTitle={current?.title ?? null} resultRequest={coachResult} />}
    </>
  );
}

/** 進度卡（學員的學習頁與課程人員的學員詳情頁共用）；time 有給才顯示學習時間 */
export function ProgressCard({ progress: p, time, titleOf }: { progress: ProgressDto; time?: LearningTimeDto; titleOf(id: string): string | undefined }) {
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
      {time && (
        <p className="muted small">
          學習時間 {formatMinutes(time.minutes)}
          {time.lastActivityAt && `・最後學習 ${formatDateTime(time.lastActivityAt)}`}
        </p>
      )}
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

type AskCoach = ((attemptId: string) => void) | undefined;

function LessonView({ lesson, canLearn, onChanged, onAskCoach }: { lesson: Lesson; canLearn: boolean; onChanged(): void; onAskCoach: AskCoach }) {
  const byId = new Map<string, OutlineActivityDto>(lesson.activities.map((a) => [a.id, a]));
  const placed = new Set(lesson.contentBlocks.filter((b) => b.type === 'activity').map((b) => (b as { activityId: string }).activityId));
  const rest = lesson.activities.filter((a) => !placed.has(a.id));
  return (
    <section className="card lesson-content">
      <h2>{lesson.title}</h2>
      {lesson.contentBlocks.map((b, i) => (
        <Block key={i} block={b} activity={b.type === 'activity' ? byId.get(b.activityId) : undefined} canLearn={canLearn} onChanged={onChanged} onAskCoach={onAskCoach} />
      ))}
      {rest.length > 0 && (
        <>
          {lesson.contentBlocks.length > 0 && <h3>活動</h3>}
          {rest.map((a) => (
            <ActivityPanel key={a.id} activity={a} canLearn={canLearn} onChanged={onChanged} onAskCoach={onAskCoach} />
          ))}
        </>
      )}
      {lesson.contentBlocks.length === 0 && lesson.activities.length === 0 && <p className="muted">這個課節還沒有內容。</p>}
    </section>
  );
}

function Block(props: { block: LessonBlock; activity: OutlineActivityDto | undefined; canLearn: boolean; onChanged(): void; onAskCoach: AskCoach }) {
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
      return props.activity ? <ActivityPanel activity={props.activity} canLearn={props.canLearn} onChanged={props.onChanged} onAskCoach={props.onAskCoach} /> : null;
    // 素材網址每次都由伺服器檢查權限（課程人員或這門課的學員）；課節中的影片只供觀看、不追蹤進度
    case 'image':
      return (
        <figure className="lesson-figure">
          <img src={assetUrl(b.assetId)} alt={b.alt} loading="lazy" />
          {b.caption && <figcaption className="muted small">{b.caption}</figcaption>}
        </figure>
      );
    case 'video':
      return (
        <figure className="lesson-figure">
          <video src={assetUrl(b.assetId)} controls preload="metadata" {...(b.poster && { poster: assetUrl(b.poster) })} />
        </figure>
      );
  }
}

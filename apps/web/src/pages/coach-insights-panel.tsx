import type { CoachAnswerStatus, CoachTranscriptDto, CoachTranscriptListDto, CoachUsageDto, CourseDetailDto } from '@iac/contracts';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Notice, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi } from '../hooks';
import { AnswerView } from './coach-view';

const STATUS_LABEL: Record<CoachAnswerStatus, string> = {
  answered: '已回答',
  cannot_modify_assessment: '拒絕改分要求',
  insufficient_evidence: '教材不足',
  out_of_scope: '超出課程範圍',
  fallback: '改用安全回答',
};
const TRIGGER_LABEL = { learner_question: '學員提問', result_trigger: '看作答結果' } as const;

/**
 * 課程頁的「AI 教練」卡片（SD §6.21）：匿名使用統計（未達匿名門檻不顯示）與學員對話紀錄。
 * 對話清單要按了才載入——每次載入與開啟都會留下稽核紀錄。
 */
export function CoachInsightsPanel({ course }: { course: CourseDetailDto }) {
  const me = useMe();
  const canStats = can(me, 'coach.usage_stats.read');
  const canRead = can(me, 'coach.conversation.read_course');
  const usage = useApi<CoachUsageDto>(canStats ? `/api/courses/${course.id}/coach/usage` : null);

  return (
    <section className="card">
      <h2>AI 教練</h2>
      {canStats && (
        <>
          <h3>使用情形（最近 30 天）</h3>
          <ErrorAlert error={usage.error} />
          {!usage.data && usage.loading && <Spinner />}
          {usage.data && <UsageView u={usage.data} />}
        </>
      )}
      {canRead && <Transcripts courseId={course.id} />}
    </section>
  );
}

function UsageView({ u }: { u: CoachUsageDto }) {
  if (u.belowThreshold || !u.statuses) {
    return <p className="muted">使用 AI 教練的學員未達 {u.threshold} 人，為避免推知個別學員，暫不顯示統計。</p>;
  }
  const q = u.questions ?? 0;
  const gap = q ? Math.round((u.statuses.insufficient_evidence / q) * 100) : 0;
  return (
    <>
      <div className="stat-row">
        <Stat label="使用學員" value={u.learners} />
        <Stat label="對話" value={u.conversations} />
        <Stat label="提問" value={u.questions} />
        <Stat label="看作答結果" value={u.resultTriggered} />
      </div>
      <p className="small">
        {(Object.keys(STATUS_LABEL) as CoachAnswerStatus[])
          .filter((s) => u.statuses![s] > 0)
          .map((s) => `${STATUS_LABEL[s]} ${u.statuses![s]}`)
          .join('・')}
      </p>
      {gap >= 20 && <Notice kind="warn">有 {gap}% 的問題因教材中找不到依據而無法回答，可以考慮補充教材或 FAQ。</Notice>}
      {u.topDocuments.length > 0 && (
        <>
          <h4>最常被引用的教材</h4>
          <ol className="small">
            {u.topDocuments.map((d) => (
              <li key={d.title}>
                {d.title}（{d.citations} 次）
              </li>
            ))}
          </ol>
        </>
      )}
      {u.activities.length > 0 && (
        <>
          <h4>各活動的提問</h4>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>活動</th>
                  <th>提問</th>
                  <th>學員</th>
                </tr>
              </thead>
              <tbody>
                {u.activities.map((a) => (
                  <tr key={a.activityId}>
                    <td>{a.title}</td>
                    <td>{a.questions}</td>
                    <td>{a.learners}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">只列出使用學員達 {u.threshold} 人以上的活動。</p>
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="stat">
      <div className="stat-value">{value ?? '—'}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function Transcripts({ courseId }: { courseId: string }) {
  const [list, setList] = useState<CoachTranscriptListDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setList(await api<CoachTranscriptListDto>('GET', `/api/courses/${courseId}/coach/conversations`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>學員對話紀錄</h3>
      <p className="muted small">每次查看清單或開啟對話都會留下稽核紀錄，學員可以在自己的「帳號活動」看到。</p>
      <ErrorAlert error={error} />
      {!list && (
        <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? '載入中…' : '查看學員對話紀錄'}
        </button>
      )}
      {list && list.policy === 'aggregate_only' && (
        <Notice kind="info">
          組織設定為不開放對話紀錄（只看匿名統計）{list.hiddenCount > 0 && `，共有 ${list.hiddenCount} 段對話`}。組織管理員可在「AI 教練設定」變更，只影響之後開始的對話。
        </Notice>
      )}
      {list && list.policy === 'course_staff' && (
        <>
          {list.data.length === 0 ? (
            <p className="muted">目前沒有可查看的對話。</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>學員</th>
                    <th>活動</th>
                    <th>類型</th>
                    <th>訊息</th>
                    <th>最後對話</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((c) => (
                    <tr key={c.id}>
                      <td>{c.learnerDisplayName}</td>
                      <td>{c.activityTitle ?? '—'}</td>
                      <td>{TRIGGER_LABEL[c.triggerType]}</td>
                      <td>{c.messageCount}</td>
                      <td className="small">{formatDateTime(c.lastMessageAt ?? c.startedAt)}</td>
                      <td>
                        <button type="button" className="btn btn-small" onClick={() => setOpen(c.id)}>
                          開啟
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.hiddenCount > 0 && <p className="muted small">另有 {list.hiddenCount} 段對話在開始時設定為不公開，無法查看。</p>}
        </>
      )}
      {open && <TranscriptModal courseId={courseId} conversationId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function TranscriptModal({ courseId, conversationId, onClose }: { courseId: string; conversationId: string; onClose(): void }) {
  const t = useApi<CoachTranscriptDto>(`/api/courses/${courseId}/coach/conversations/${conversationId}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const d = t.data;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="對話紀錄" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="grow">{d ? `${d.learnerDisplayName}・${d.activityTitle ?? '課程'}（${TRIGGER_LABEL[d.triggerType]}）` : '對話紀錄'}</strong>
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose} autoFocus>
            關閉
          </button>
        </div>
        <div className="modal-body coach-transcript">
          <ErrorAlert error={t.error} />
          {!d && t.loading && <Spinner />}
          {d?.messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="chat-user">
                {m.content}
                <div className="muted small">{formatDateTime(m.createdAt)}</div>
              </div>
            ) : (
              <AnswerView key={m.id} a={{ status: m.status ?? 'answered', answer: m.content, citations: m.citations, followUpQuestions: m.followUpQuestions }} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

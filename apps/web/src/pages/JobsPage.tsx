import type { JobQueueStatus } from '@iac/contracts';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';

/** 等待時間：秒 → 可讀字串 */
export function formatAge(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天`;
}

/** SA §18.2：oldest pending > 30 分鐘告警 */
const OLDEST_WARN_SEC = 1800;

export function JobsPage() {
  useTitle('背景工作');
  const me = useMe();
  const st = useApi<JobQueueStatus>(can(me, 'platform.health.read') ? '/api/system/jobs' : null);

  if (!can(me, 'platform.health.read')) return <Forbidden />;
  const d = st.data;

  return (
    <>
      <PageHeader
        title="背景工作"
        subtitle={d ? `更新於 ${formatDateTime(d.generatedAt)}` : undefined}
        actions={
          <button className="btn" onClick={st.reload} disabled={st.loading}>
            {st.loading ? '更新中…' : '重新整理'}
          </button>
        }
      />
      <ErrorAlert error={st.error} />
      {!d ? (
        st.loading && <Spinner />
      ) : (
        <>
          {d.staleLocks > 0 && <Notice kind="warn">有 {d.staleLocks} 個工作的鎖已過期（worker 可能中斷），下次取件時會自動回收。</Notice>}
          {d.deadLetters.total > 0 && <Notice kind="warn">有 {d.deadLetters.total} 個工作重試失敗後已放棄（DLQ），請檢查下方錯誤。</Notice>}

          <section className="card">
            <h2>佇列</h2>
            {d.queues.length === 0 ? (
              <p className="muted">目前沒有待處理或最近完成的工作。</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>佇列</th>
                      <th>工作類型</th>
                      <th>待處理</th>
                      <th>執行中</th>
                      <th>24 小時內完成</th>
                      <th>最久等待</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.queues.map((q) => (
                      <tr key={`${q.queue}/${q.jobType}`}>
                        <td>{q.queue}</td>
                        <td>
                          <code>{q.jobType}</code>
                        </td>
                        <td>{q.pending}</td>
                        <td>{q.running}</td>
                        <td>{q.succeeded24h}</td>
                        <td>
                          {q.oldestPendingSeconds !== null && q.oldestPendingSeconds > OLDEST_WARN_SEC ? (
                            <span className="badge badge-grace">{formatAge(q.oldestPendingSeconds)}</span>
                          ) : (
                            formatAge(q.oldestPendingSeconds)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>已放棄的工作（最近 {d.deadLetters.recent.length} 筆）</h2>
            {d.deadLetters.recent.length === 0 ? (
              <p className="muted">沒有。</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>時間</th>
                      <th>工作類型</th>
                      <th>嘗試次數</th>
                      <th>錯誤</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.deadLetters.recent.map((j) => (
                      <tr key={j.id}>
                        <td className="nowrap">{formatDateTime(j.failedAt)}</td>
                        <td>
                          <code>{j.jobType}</code>
                          <div className="muted small">{j.queue}</div>
                        </td>
                        <td>{j.attempts}</td>
                        <td>
                          <pre className="error-text">{j.error}</pre>
                          {j.correlationId && <div className="muted small">追蹤代碼：{j.correlationId}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

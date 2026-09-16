import type { BackupRunDto, SystemAlertDto, SystemStatusDto } from '@iac/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { BACKUP_STATUS_BADGE, BACKUP_STATUS_LABELS, formatBytes, formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';
import { formatAge } from './JobsPage';

const ALERT_KIND: Record<SystemAlertDto['level'], 'info' | 'warn' | 'error'> = { info: 'info', warning: 'warn', critical: 'error' };
const percent = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

/** /app/platform/system-status：平台管理員的一頁總覽（SA UC-PLT-010、SD §6.28） */
export function SystemStatusPage() {
  useTitle('系統狀態');
  const me = useMe();
  const allowed = can(me, 'platform.health.read');
  const canBackup = can(me, 'platform.backup.execute');
  const st = useApi<SystemStatusDto>(allowed ? '/api/system/status' : null);
  const backups = useApi<BackupRunDto[]>(canBackup ? '/api/platform/backups' : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!allowed) return <Forbidden />;
  const d = st.data;

  async function backupNow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api<BackupRunDto>('POST', '/api/platform/backups');
      setNotice('已排入備份，備份服務會在一分鐘內開始；完成後這裡會顯示結果。');
      backups.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function refresh() {
    st.reload();
    backups.reload();
  }

  return (
    <>
      <PageHeader
        title="系統狀態"
        subtitle={d ? `更新於 ${formatDateTime(d.generatedAt)}` : undefined}
        actions={
          <>
            <button type="button" className="btn" onClick={refresh} disabled={st.loading}>
              {st.loading ? '更新中…' : '重新整理'}
            </button>
            {canBackup && (
              <button type="button" className="btn btn-primary" onClick={() => void backupNow()} disabled={busy}>
                {busy ? '排入中…' : '立即備份'}
              </button>
            )}
          </>
        }
      />
      <ErrorAlert error={error ?? st.error} />
      {notice && <Notice kind="ok">{notice}</Notice>}
      {!d ? (
        st.loading && <Spinner />
      ) : (
        <>
          {d.alerts.length === 0 ? (
            <Notice kind="ok">目前沒有需要處理的問題。</Notice>
          ) : (
            d.alerts.map((a) => (
              <Notice key={a.key} kind={ALERT_KIND[a.level]}>
                {a.message}
              </Notice>
            ))
          )}

          <div className="card-grid">
            <section className="card">
              <h2>背景工作</h2>
              <p className="stat">{d.jobs.pending}</p>
              <p className="muted small">
                待處理・執行中 {d.jobs.running}・最久等待 {formatAge(d.jobs.oldestPendingSeconds)}
                <br />
                已放棄 {d.jobs.deadLetters}・過期鎖 {d.jobs.staleLocks}
              </p>
              <Link to="/app/platform/jobs">查看背景工作</Link>
            </section>

            <section className="card">
              <h2>教材與搜尋</h2>
              <p className="stat">{d.search.pendingDocuments}</p>
              <p className="muted small">
                處理中的教材・失敗 {d.search.failedDocuments}
                <br />
                搜尋服務：{d.search.configured ? '已設定' : '未設定（AI 教練無法引用教材）'}
              </p>
            </section>

            <section className="card">
              <h2>AI 用量（今天）</h2>
              <p className="stat">{d.ai.tokensToday.toLocaleString('zh-TW')}</p>
              <p className="muted small">
                token／每日上限 {d.ai.dailyBudget.toLocaleString('zh-TW')}
                <br />
                呼叫 {d.ai.requestsToday}・失敗 {d.ai.errorsToday}・安全替代回答 {percent(d.ai.fallbackRatio)}
              </p>
            </section>

            <section className="card">
              <h2>儲存用量</h2>
              <p className="stat">{formatBytes(d.storage.databaseBytes)}</p>
              <p className="muted small">
                資料庫
                <br />
                教材 {formatBytes(d.storage.documentBytes)}・素材 {formatBytes(d.storage.mediaBytes)}
              </p>
            </section>

            <section className="card">
              <h2>授權</h2>
              <p className="stat">{d.license.daysToExpiry === null ? '—' : `${d.license.daysToExpiry} 天`}</p>
              <p className="muted small">
                到期倒數（狀態：{d.license.state}）
                <br />
                進行中的學員 {d.license.activeLearners}
                {d.license.maxActiveLearners !== null && `／${d.license.maxActiveLearners}`}
                {d.license.daysToMaintenanceEnd !== null && <>・維護期剩 {d.license.daysToMaintenanceEnd} 天</>}
              </p>
              <Link to="/app/platform/license">授權管理</Link>
            </section>

            <section className="card">
              <h2>備份</h2>
              <p className="stat">{d.backup.ageHours === null ? '尚未備份' : `${d.backup.ageHours} 小時前`}</p>
              <p className="muted small">
                最近一次成功：{formatDateTime(d.backup.lastSucceededAt)}
                <br />
                最新一次狀態：{d.backup.lastStatus ? BACKUP_STATUS_LABELS[d.backup.lastStatus] : '—'}
              </p>
            </section>
          </div>

          {canBackup && (
            <section className="card">
              <h2>備份紀錄</h2>
              <p className="muted small">
                每天自動備份資料庫與教材檔案，保留 7 日／4 週／6 月。備份檔留在備份主機上；異地保存與還原步驟見 docs/ops/backup-restore.md。
              </p>
              <ErrorAlert error={backups.error} />
              {!backups.data && backups.loading && <Spinner />}
              {backups.data && backups.data.length === 0 && <p className="muted">還沒有備份紀錄。</p>}
              {backups.data && backups.data.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>時間</th>
                        <th>方式</th>
                        <th>狀態</th>
                        <th>資料庫</th>
                        <th>檔案</th>
                        <th>位置</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.data.map((b) => (
                        <tr key={b.id}>
                          <td className="nowrap">{formatDateTime(b.finishedAt ?? b.startedAt ?? b.createdAt)}</td>
                          <td>
                            {b.kind === 'daily' ? '每日' : '手動'}
                            {b.requestedByName && <div className="muted small">{b.requestedByName}</div>}
                          </td>
                          <td>
                            <span className={`badge ${BACKUP_STATUS_BADGE[b.status]}`}>{BACKUP_STATUS_LABELS[b.status]}</span>
                            {b.error && <pre className="error-text">{b.error}</pre>}
                          </td>
                          <td>{b.databaseBytes === null ? '—' : formatBytes(b.databaseBytes)}</td>
                          <td>
                            {b.objectFiles === null ? '—' : `${b.objectFiles} 個`}
                            {b.objectBytes !== null && <div className="muted small">{formatBytes(b.objectBytes)}</div>}
                          </td>
                          <td className="small">{b.location ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}

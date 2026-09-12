import type { AuditLogDto, AuditLogPage } from '@iac/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiDownload, saveBlob } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { actionLabel, formatDateTime } from '../format';
import { useTitle } from '../hooks';

/** 日期欄位（本地日期）→ ISO：開始取當天 00:00，結束取隔天 00:00（API 的 to 不含） */
function dayStart(d: string): string {
  return new Date(`${d}T00:00:00`).toISOString();
}
function dayEnd(d: string): string {
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + 1);
  return t.toISOString();
}
function isoDay(offsetDays: number): string {
  const t = new Date();
  t.setDate(t.getDate() + offsetDays);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const OUTCOME: Record<AuditLogDto['outcome'], [string, string]> = {
  success: ['成功', 'badge-active'],
  denied: ['拒絕', 'badge-blocked'],
  error: ['錯誤', 'badge-grace'],
};

interface Filters {
  action: string;
  from: string;
  to: string;
}

export function AuditPage() {
  const me = useMe();
  const full = can(me, 'audit.read_platform') || can(me, 'audit.read_org') || can(me, 'audit.read_course');
  const allowed = full || can(me, 'audit.read_self');
  const title = full ? '稽核紀錄' : '帳號活動';
  useTitle(title);

  const [draft, setDraft] = useState<Filters>({ action: '', from: '', to: '' });
  const [filters, setFilters] = useState<Filters>(draft);
  const [rows, setRows] = useState<AuditLogDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: '50' });
        if (filters.action.trim()) q.set('action', filters.action.trim());
        if (filters.from) q.set('from', dayStart(filters.from));
        if (filters.to) q.set('to', dayEnd(filters.to));
        if (cursor) q.set('cursor', cursor);
        const r = await api<AuditLogPage>('GET', `/api/audit-logs?${q.toString()}`);
        setRows((old) => (cursor ? [...old, ...r.data] : r.data));
        setNext(r.meta.next_cursor);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    if (allowed) void load(null);
  }, [allowed, load]);

  if (!allowed) return <Forbidden />;

  function onFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setOpen(null);
    setFilters(draft);
  }

  return (
    <>
      <PageHeader
        title={title}
        subtitle={full ? '依您的管理範圍顯示；紀錄一經寫入即無法修改或刪除。' : '與您帳號相關的登入、權限變更與資料存取紀錄。'}
      />

      <section className="card">
        <form className="form-grid" onSubmit={onFilter}>
          {full && (
            <Field label="動作" hint="例：org.updated，或 org.* 查詢同類動作">
              <input value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value.toLowerCase() })} maxLength={100} spellCheck={false} />
            </Field>
          )}
          <Field label="開始日期">
            <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </Field>
          <Field label="結束日期">
            <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              查詢
            </button>
          </div>
        </form>
      </section>

      {can(me, 'audit.export') && <ExportPanel />}

      <section className="card">
        <ErrorAlert error={error} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>時間</th>
                <th>動作</th>
                <th>執行者</th>
                <th>對象</th>
                <th>結果</th>
                {full && <th aria-label="詳細" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <AuditRow key={r.id} row={r} expandable={full && r.visibility === 'full'} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
        {loading && <Spinner />}
        {!loading && rows.length === 0 && !error && <p className="muted">沒有符合條件的紀錄。</p>}
        {next && !loading && (
          <button className="btn" onClick={() => void load(next)}>
            載入更多
          </button>
        )}
      </section>
    </>
  );
}

function AuditRow({ row: r, expandable, open, onToggle }: { row: AuditLogDto; expandable: boolean; open: boolean; onToggle(): void }) {
  const [label, badge] = OUTCOME[r.outcome];
  return (
    <>
      <tr>
        <td className="nowrap">{formatDateTime(r.occurredAt)}</td>
        <td>
          <div>{actionLabel(r.action)}</div>
          {actionLabel(r.action) !== r.action && <div className="muted small">{r.action}</div>}
        </td>
        <td>{r.actor ? (r.actor.displayName ?? r.actor.id) : <span className="muted">系統／匿名</span>}</td>
        <td className="muted small">{r.resourceType}</td>
        <td>
          <span className={`badge ${badge}`}>{label}</span>
        </td>
        {expandable && (
          <td className="actions">
            <button className="btn btn-small" onClick={onToggle} aria-expanded={open}>
              {open ? '收合' : '詳細'}
            </button>
          </td>
        )}
      </tr>
      {open && (
        <tr className="row-editor">
          <td colSpan={6}>
            <dl className="kv">
              {r.actor?.email && (
                <>
                  <dt>執行者 Email</dt>
                  <dd>{r.actor.email}</dd>
                </>
              )}
              <dt>IP</dt>
              <dd>{r.ip ?? '—'}</dd>
              <dt>追蹤代碼</dt>
              <dd>
                <code className="wrap">{r.correlationId ?? '—'}</code>
              </dd>
              <dt>對象 ID</dt>
              <dd>
                <code className="wrap">{r.resourceId ?? '—'}</code>
              </dd>
            </dl>
            {(r.before != null || r.after != null) && (
              <div className="diff">
                <div>
                  <h3>變更前</h3>
                  <pre>{JSON.stringify(r.before ?? null, null, 2)}</pre>
                </div>
                <div>
                  <h3>變更後</h3>
                  <pre>{JSON.stringify(r.after ?? null, null, 2)}</pre>
                </div>
              </div>
            )}
            {r.metadata && Object.keys(r.metadata).length > 0 && <pre>{JSON.stringify(r.metadata, null, 2)}</pre>}
          </td>
        </tr>
      )}
    </>
  );
}

function ExportPanel() {
  const [from, setFrom] = useState(isoDay(-30));
  const [to, setTo] = useState(isoDay(0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onExport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { blob, filename } = await apiDownload('POST', '/api/audit-logs/export', { from: dayStart(from), to: dayEnd(to) });
      saveBlob(blob, filename);
      setDone(`已下載 ${filename}。匯出動作本身也會記錄在稽核紀錄中。`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>匯出 CSV</h2>
      <p className="muted small">區間最多 366 天、最多 50,000 筆。檔案以 UTF-8 編碼，可直接用 Excel 開啟。</p>
      {done && <Notice kind="ok">{done}</Notice>}
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onExport(e)}>
        <Field label="開始日期">
          <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="結束日期">
          <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? '匯出中…' : '下載 CSV'}
          </button>
        </div>
      </form>
    </section>
  );
}

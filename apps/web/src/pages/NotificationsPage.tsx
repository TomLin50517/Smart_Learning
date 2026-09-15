import { notificationLink, type NotificationDto, type NotificationPreferenceDto, type NotificationType } from '@iac/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { ErrorAlert, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../format';
import { useApi, useTitle } from '../hooks';
import { NOTIFICATION_TYPE_LABELS, notificationText } from '../notify-lib';

interface Page {
  data: NotificationDto[];
  meta: { next_cursor: string | null; unread: number };
}

/** /app/notifications：本人的站內通知與通知設定（SA UC-AUD-003／004、SD §6.26）。只要登入即可使用 */
export function NotificationsPage() {
  useTitle('通知');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load(reset: boolean) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '30' });
      if (unreadOnly) qs.set('unread', 'true');
      if (!reset && cursor) qs.set('cursor', cursor);
      const r = await api<Page>('GET', `/api/notifications?${qs.toString()}`);
      setItems((prev) => (reset ? r.data : [...prev, ...r.data]));
      setCursor(r.meta.next_cursor);
      setUnread(r.meta.unread);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在篩選改變時重新載入
  }, [unreadOnly]);

  function markLocal(ids: 'all' | string) {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt || (ids !== 'all' && n.id !== ids) ? n : { ...n, readAt: now })));
  }

  async function open(n: NotificationDto) {
    if (n.readAt) return;
    markLocal(n.id);
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api('POST', `/api/notifications/${n.id}/read`);
    } catch {
      // 標為已讀失敗不影響前往連結
    }
  }

  async function readAll() {
    setError(null);
    try {
      await api('POST', '/api/notifications/read-all');
      markLocal('all');
      setUnread(0);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <PageHeader
        title="通知"
        subtitle={unread ? `${unread} 則未讀` : '沒有未讀的通知'}
        actions={
          unread > 0 ? (
            <button type="button" className="btn" onClick={() => void readAll()}>
              全部標為已讀
            </button>
          ) : undefined
        }
      />
      <section className="card">
        <div className="toolbar">
          <label className="check">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            只看未讀
          </label>
        </div>
        <ErrorAlert error={error} />
        <ul className="notification-list">
          {items.map((n) => (
            <li key={n.id} className={n.readAt ? undefined : 'unread'}>
              <Link to={notificationLink(n.type, n.payload)} onClick={() => void open(n)}>
                {notificationText(n)}
              </Link>
              <span className="muted small">{formatDateTime(n.createdAt)}</span>
            </li>
          ))}
        </ul>
        {loading && <Spinner />}
        {!loading && items.length === 0 && <p className="muted">{unreadOnly ? '沒有未讀的通知。' : '目前沒有通知。'}</p>}
        {cursor && !loading && (
          <button type="button" className="btn" onClick={() => void load(false)}>
            載入更多
          </button>
        )}
      </section>
      <PreferencesCard />
    </>
  );
}

/** 通知設定：每一類通知要不要顯示在站內、要不要寄 Email */
function PreferencesCard() {
  const prefs = useApi<NotificationPreferenceDto[]>('/api/me/notification-preferences');
  const [draft, setDraft] = useState<NotificationPreferenceDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const rows = draft ?? prefs.data ?? [];

  function set(type: NotificationType, key: 'inApp' | 'email', value: boolean) {
    setSaved(false);
    setDraft(rows.map((r) => (r.type === type ? { ...r, [key]: value } : r)));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/me/notification-preferences', { preferences: rows });
      setDraft(null);
      setSaved(true);
      prefs.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>通知設定</h2>
      <p className="muted small">選擇每一類通知要不要顯示在站內、要不要寄 Email（寄到你的登入信箱）。信件只有課程名稱與連結，不含成績。</p>
      <ErrorAlert error={prefs.error ?? error} />
      {saved && <Notice kind="ok">已儲存。</Notice>}
      {!prefs.data && prefs.loading && <Spinner />}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>通知</th>
                <th>站內</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.type}>
                  <td>{NOTIFICATION_TYPE_LABELS[r.type]}</td>
                  <td>
                    <input type="checkbox" aria-label={`${NOTIFICATION_TYPE_LABELS[r.type]}：站內`} checked={r.inApp} disabled={busy} onChange={(e) => set(r.type, 'inApp', e.target.checked)} />
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`${NOTIFICATION_TYPE_LABELS[r.type]}：Email`} checked={r.email} disabled={busy} onChange={(e) => set(r.type, 'email', e.target.checked)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !draft} onClick={() => void save()}>
          {busy ? '儲存中…' : '儲存'}
        </button>
      </div>
    </section>
  );
}

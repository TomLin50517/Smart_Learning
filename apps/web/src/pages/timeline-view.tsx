import type { EnrollmentTimelineDto, LearningTimeDto, TimelineItemDto } from '@iac/contracts';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorAlert, Spinner } from '../components/ui';
import { formatDateTime, formatMinutes } from '../format';
import { useApi } from '../hooks';
import { timelineText } from '../learn-lib';

const PAGE = 30;

/** 學習歷程（SD §6.13）：各單元學習時間＋紀錄列表（新到舊，「載入更早的紀錄」往前翻）。學員與課程人員共用 */
export function TimelineView({ path }: { path: string }) {
  const first = useApi<EnrollmentTimelineDto>(`${path}?limit=${PAGE}`);
  const [more, setMore] = useState<{ items: TimelineItemDto[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setMore(null), [first.data]);

  if (!first.data) return first.loading ? <Spinner /> : <ErrorAlert error={first.error} />;
  const items = [...first.data.data, ...(more?.items ?? [])];
  const cursor = more ? more.cursor : first.data.meta.next_cursor;

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<EnrollmentTimelineDto>('GET', `${path}?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
      setMore((m) => ({ items: [...(m?.items ?? []), ...r.data], cursor: r.meta.next_cursor }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TimeByModule time={first.data.time} />
      <ErrorAlert error={error} />
      {items.length === 0 ? (
        <p className="muted">還沒有學習紀錄。</p>
      ) : (
        <ol className="timeline">
          {items.map((x) => (
            <li key={x.id}>
              <time dateTime={x.occurredAt}>{formatDateTime(x.occurredAt)}</time>
              <span>{timelineText(x)}</span>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button type="button" className="btn" disabled={busy} onClick={() => void loadMore()}>
          {busy ? '載入中…' : '載入更早的紀錄'}
        </button>
      )}
    </>
  );
}

export function TimeByModule({ time }: { time: LearningTimeDto }) {
  return (
    <div className="time-summary">
      <p>
        <strong>學習時間 {formatMinutes(time.minutes)}</strong>
        {time.lastActivityAt && <span className="muted small">・最後學習 {formatDateTime(time.lastActivityAt)}</span>}
      </p>
      {time.byModule.length > 0 && (
        <ul className="small">
          {time.byModule.map((m) => (
            <li key={m.moduleId}>
              {m.title}：{formatMinutes(m.minutes)}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">學習時間以作答中、學習畫面在前景的時間計算；離開超過 5 分鐘的時段不計入。</p>
    </div>
  );
}

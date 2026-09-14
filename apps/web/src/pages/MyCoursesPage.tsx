import type { CatalogCourseDto, JoinResultDto, MyEnrollmentDto } from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { ENROLLMENT_STATUS_BADGE, ENROLLMENT_STATUS_LABELS, formatDate } from '../format';
import { useApi, useTitle } from '../hooks';

const AVAILABILITY_TEXT = { not_yet: '尚未開放', closed: '已截止', full: '名額已滿' } as const;

function joinedText(r: JoinResultDto): string {
  if (r.alreadyEnrolled) return r.status === 'pending' ? `你已經申請過「${r.courseTitle}」，正在等待審核。` : `你已經在「${r.courseTitle}」裡了。`;
  return r.status === 'pending' ? `已送出「${r.courseTitle}」的加入申請，老師核准後就能開始學習。` : `已加入「${r.courseTitle}」。`;
}

/** /app/learn：學員的「我的課程」（UC-ENR-010）：輸入選課碼加入、課程目錄（UC-ENR-002／003；SD §6.24） */
export function MyCoursesPage() {
  useTitle('我的課程');
  const me = useMe();
  const allowed = can(me, 'learning.result.read_self');
  const canJoin = can(me, 'enrollment.self_enroll');
  const list = useApi<MyEnrollmentDto[]>(allowed ? '/api/me/enrollments' : null);
  const catalog = useApi<CatalogCourseDto[]>(allowed && canJoin ? '/api/me/catalog' : null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [joined, setJoined] = useState<JoinResultDto | null>(null);

  if (!allowed) return <Forbidden />;
  const multiOrg = new Set((list.data ?? []).map((e) => e.organizationId)).size > 1;

  async function join(fn: () => Promise<JoinResultDto>) {
    setBusy(true);
    setError(null);
    setJoined(null);
    try {
      setJoined(await fn());
      setCode('');
      list.reload();
      catalog.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void join(() => api<JoinResultDto>('POST', '/api/me/enrollments/join', { code: code.trim() }));
  }

  const open = (catalog.data ?? []).filter((c) => !c.myEnrollment);
  return (
    <>
      <PageHeader title="我的課程" subtitle="被指派或加入的課程。" />
      <ErrorAlert error={list.error} />

      {canJoin && (
        <section className="card">
          <h2>加入課程</h2>
          <form className="row" onSubmit={submit}>
            <input
              className="grow enroll-code-input"
              maxLength={20}
              value={code}
              placeholder="輸入老師提供的選課碼"
              aria-label="選課碼"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || code.trim().length < 4}>
              {busy ? '處理中…' : '加入'}
            </button>
          </form>
          {joined && <Notice kind="ok">{joinedText(joined)}</Notice>}
          <ErrorAlert error={error} />
          {open.length > 0 && (
            <>
              <h3>可加入的課程</h3>
              <ul className="catalog-list">
                {open.map((c) => (
                  <li key={c.id}>
                    <div className="grow">
                      <strong>{c.title}</strong> <code className="muted small">{c.code}</code>
                      {c.description && <div className="muted small">{c.description}</div>}
                    </div>
                    {c.availability === 'open' ? (
                      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void join(() => api<JoinResultDto>('POST', `/api/courses/${c.id}/join`))}>
                        {c.requireApproval ? '申請加入' : '加入'}
                      </button>
                    ) : (
                      <span className="muted small">{AVAILABILITY_TEXT[c.availability]}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.length === 0 && (
        <section className="card">
          <p className="muted">目前沒有課程。{canJoin ? '可以輸入老師提供的選課碼加入，或等老師指派。' : '老師或管理員指派課程後會出現在這裡。'}</p>
        </section>
      )}
      <div className="card-grid">
        {(list.data ?? []).map((e) => (
          <section key={e.id} className="card">
            <p className="muted small">
              <code>{e.course.code}</code>
              {multiOrg && <>・{e.organizationName}</>}
            </p>
            <h2>{e.course.title}</h2>
            <p>
              <span className={`badge ${ENROLLMENT_STATUS_BADGE[e.status]}`}>{ENROLLMENT_STATUS_LABELS[e.status]}</span>{' '}
              <span className="muted small">v{e.versionNo}</span>
            </p>
            <p className="muted small">
              {e.status === 'pending' ? '申請' : '加入'}：{formatDate(e.enrolledAt)}
              {e.dueDate && <>・期限：{formatDate(e.dueDate)}</>}
              {e.completedAt && <>・完成：{formatDate(e.completedAt)}</>}
            </p>
            {e.canLearn || e.status === 'completed' ? (
              <Link className="btn btn-primary" to={`/app/learn/${e.id}`}>
                {e.status === 'completed' ? '回顧課程' : '進入課程'}
              </Link>
            ) : (
              <button type="button" className="btn" disabled>
                {e.status === 'pending' ? '等待老師審核' : '目前無法學習'}
              </button>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

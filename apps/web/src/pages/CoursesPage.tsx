import type { CourseDto, CourseStatus } from '@iac/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { COURSE_STATUS_LABELS, VERSION_STATUS_LABELS } from '../format';
import { useTitle } from '../hooks';

interface Page {
  data: CourseDto[];
  meta: { next_cursor: string | null };
}

/** /app/courses（SD §7.1）：可見範圍由伺服器依 course.read 過濾 */
export function CoursesPage() {
  useTitle('課程管理');
  const me = useMe();
  const [items, setItems] = useState<CourseDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusFilter, setStatusFilter] = useState<CourseStatus | ''>('');

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: '50', ...(cursor && { cursor }), ...(statusFilter && { status: statusFilter }) });
        const r = await api<Page>('GET', `/api/courses?${q.toString()}`);
        setItems((old) => (cursor ? [...old, ...r.data] : r.data));
        setNext(r.meta.next_cursor);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    if (can(me, 'course.read')) void load(null);
  }, [me, load]);

  if (!can(me, 'course.read')) return <Forbidden />;
  const multiOrg = new Set(items.map((c) => c.organizationId)).size > 1;
  const orgName = (id: string) => me.organizations.find((o) => o.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader title="課程管理" subtitle="課程內容以版本管理：已發布的版本不可修改，要調整請複製為新版本。" />
      {can(me, 'course.create') && me.activeOrganization && <CreateCourse onCreated={() => void load(null)} />}
      <section className="card">
        <h2>課程</h2>
        <div className="toolbar">
          <select aria-label="依狀態篩選" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CourseStatus | '')}>
            <option value="">全部狀態</option>
            {(Object.keys(COURSE_STATUS_LABELS) as CourseStatus[]).map((s) => (
              <option key={s} value={s}>
                {COURSE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <ErrorAlert error={error} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>代碼</th>
                <th>名稱</th>
                <th>講師</th>
                {multiOrg && <th>組織</th>}
                <th>狀態</th>
                <th>已發布版本</th>
                <th>編輯中</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <code>{c.code}</code>
                  </td>
                  <td>
                    <Link to={`/app/courses/${c.id}`}>{c.title}</Link>
                  </td>
                  <td>
                    <StaffCell staff={c.staff} />
                  </td>
                  {multiOrg && <td className="muted small">{orgName(c.organizationId)}</td>}
                  <td>
                    <span className={`badge ${c.status === 'active' ? 'badge-active' : c.status === 'archived' ? '' : 'badge-grace'}`}>
                      {COURSE_STATUS_LABELS[c.status]}
                    </span>
                  </td>
                  <td>{c.publishedVersion ? `v${c.publishedVersion.versionNo}` : <span className="muted">—</span>}</td>
                  <td>
                    {c.workingVersion ? `v${c.workingVersion.versionNo}（${VERSION_STATUS_LABELS[c.workingVersion.status]}）` : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && <Spinner />}
        {!loading && items.length === 0 && !error && <p className="muted">{statusFilter ? '沒有符合條件的課程。' : '目前沒有可檢視的課程。'}</p>}
        {next && !loading && (
          <button className="btn" onClick={() => void load(next)}>
            載入更多
          </button>
        )}
      </section>
    </>
  );
}

/** 講師姓名；尚未指派講師時醒目標示，管理員不必逐一點進課程查看 */
function StaffCell({ staff }: { staff: CourseDto['staff'] }) {
  const names = (role: CourseDto['staff'][number]['role']) =>
    staff
      .filter((s) => s.role === role)
      .map((s) => s.displayName)
      .join('、');
  const instructors = names('instructor');
  if (instructors) return <>{instructors}</>;
  const admins = names('course_admin');
  return (
    <>
      <span className="badge badge-grace">未指派</span>
      {admins && <div className="muted small">課程管理員：{admins}</div>}
    </>
  );
}

function CreateCourse({ onCreated }: { onCreated(): void }) {
  const me = useMe();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const writable = me.licenseCapabilities.authoringAllowed;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api<CourseDto>('POST', '/api/courses', {
        ...(code.trim() && { code: code.trim() }),
        title: title.trim(),
        ...(description.trim() && { description: description.trim() }),
      });
      onCreated();
      navigate(`/app/courses/${c.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>建立課程</h2>
      <p className="muted small">建立於目前的組織「{me.activeOrganization?.name}」。建立後再指派講師，由講師編輯內容。</p>
      {!writable && <Notice kind="warn">目前的授權不允許課程編輯。</Notice>}
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
        <fieldset disabled={!writable || busy}>
          <Field label="課程名稱">
            <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="代碼（選填）" hint="留空則自動編號（C-0001 起）；也可填入自己的課號（英數字、連字號與底線）">
            <input
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,63}"
              placeholder="自動編號"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field label="說明（選填）">
            <textarea rows={2} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '建立中…' : '建立課程'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

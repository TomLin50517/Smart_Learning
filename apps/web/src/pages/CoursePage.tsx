import {
  COURSE_STAFF_ROLES,
  NAVIGATION_MODES,
  type CourseDetailDto,
  type CourseStaffDto,
  type CourseStaffRole,
  type CourseVersionDetailDto,
  type CourseVersionSummaryDto,
  type NavigationMode,
  type VersionImpactDto,
} from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { COURSE_STATUS_LABELS, formatDateTime, NAVIGATION_MODE_LABELS, ROLE_LABELS, VERSION_STATUS_BADGE, VERSION_STATUS_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';
import { LearnersPanel } from './learners-panel';

/** /app/courses/:courseId：課程總覽、版本清單、課程人員 */
export function CoursePage() {
  const { courseId = '' } = useParams();
  const me = useMe();
  const course = useApi<CourseDetailDto>(can(me, 'course.read') ? `/api/courses/${courseId}` : null);
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useTitle(course.data?.title ?? '課程');

  if (!can(me, 'course.read')) return <Forbidden />;
  if (!course.data) return course.loading ? <Spinner /> : <ErrorAlert error={course.error} />;
  const c = course.data;
  const authoring = me.licenseCapabilities.authoringAllowed;
  const canCreateVersion = can(me, 'course.version.create') && authoring && c.status !== 'archived' && !c.workingVersion;

  async function cloneVersion(v: CourseVersionSummaryDto) {
    setActionError(null);
    try {
      const impact = await api<VersionImpactDto>('GET', `/api/course-versions/${v.id}/impact`);
      const ok = window.confirm(
        `目前有 ${impact.activeLearners} 位學員正在使用 v${v.versionNo}（另有 ${impact.completedLearners} 位已完成）。\n\n` +
          '複製會建立一個新的草稿版本；既有學員仍使用原版本，不受影響。要繼續嗎？',
      );
      if (!ok) return;
      setBusy(true);
      const copy = await api<CourseVersionDetailDto>('POST', `/api/course-versions/${v.id}/clone`);
      navigate(`/app/courses/${c.id}/versions/${copy.id}/edit`);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!window.confirm(`確定要封存「${c.title}」？封存後將不再接受新的選課，既有學員仍可完成課程。`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api('PATCH', `/api/courses/${c.id}`, { status: 'archived' });
      course.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!window.confirm(`確定要恢復「${c.title}」？恢復後可以再建立新版本${c.publishedVersion ? '，並重新接受選課' : ''}。`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api('POST', `/api/courses/${c.id}/restore`);
      course.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={c.title}
        subtitle={
          <>
            <code>{c.code}</code>・{COURSE_STATUS_LABELS[c.status]}
            {c.description && <span>・{c.description}</span>}
          </>
        }
        actions={
          !can(me, 'course.archive') ? undefined : c.status !== 'archived' ? (
            <button className="btn btn-danger" onClick={() => void archive()} disabled={busy || !authoring}>
              封存課程
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => void restore()} disabled={busy || !authoring}>
              恢復課程
            </button>
          )
        }
      />
      <p>
        <Link to="/app/courses">← 課程列表</Link>
      </p>
      {c.status === 'archived' && (
        <Notice kind="info">
          此課程已封存：不再接受新的選課，也不能建立新版本。
          {can(me, 'course.archive') && '如需重新開放，請按右上角「恢復課程」。'}
        </Notice>
      )}
      <ErrorAlert error={actionError} />

      <section className="card">
        <h2>版本</h2>
        {c.versions.length === 0 ? (
          <p className="muted">還沒有任何版本。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>名稱</th>
                  <th>狀態</th>
                  <th>發布時間</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {c.versions.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.versionNo}</td>
                    <td>{v.title}</td>
                    <td>
                      <span className={`badge ${VERSION_STATUS_BADGE[v.status]}`}>{VERSION_STATUS_LABELS[v.status]}</span>
                    </td>
                    <td>{formatDateTime(v.publishedAt)}</td>
                    <td className="actions">
                      {can(me, 'course.version.read') && (
                        <Link to={`/app/courses/${c.id}/versions/${v.id}/edit`}>{v.status === 'draft' && can(me, 'course.version.write') ? '編輯' : '檢視'}</Link>
                      )}
                      {can(me, 'course.version.create') && (v.status === 'published' || v.status === 'superseded') && (
                        <button
                          className="btn btn-small"
                          disabled={busy || !authoring || !!c.workingVersion || c.status === 'archived'}
                          title={c.workingVersion ? `已有編輯中的 v${c.workingVersion.versionNo}` : undefined}
                          onClick={() => void cloneVersion(v)}
                        >
                          複製為新版本
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canCreateVersion && c.versions.length === 0 && <CreateVersion course={c} />}
      </section>

      {can(me, 'course.staff.assign') && <StaffPanel courseId={c.id} />}
      {can(me, 'learning.result.read_all') && <LearnersPanel course={c} />}
    </>
  );
}

function CreateVersion({ course }: { course: CourseDetailDto }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(course.title);
  const [mode, setMode] = useState<NavigationMode>('mixed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const v = await api<CourseVersionDetailDto>('POST', `/api/courses/${course.id}/versions`, { title: title.trim(), navigationMode: mode });
      navigate(`/app/courses/${course.id}/versions/${v.id}/edit`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      <h3>建立第一個版本</h3>
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
        <fieldset disabled={busy}>
          <Field label="版本名稱">
            <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="學習順序">
            <select value={mode} onChange={(e) => setMode(e.target.value as NavigationMode)}>
              {NAVIGATION_MODES.map((m) => (
                <option key={m} value={m}>
                  {NAVIGATION_MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '建立中…' : '建立草稿'}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

function StaffPanel({ courseId }: { courseId: string }) {
  const me = useMe();
  const staff = useApi<CourseStaffDto[]>(`/api/courses/${courseId}/staff`);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CourseStaffRole>('instructor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const writable = me.licenseCapabilities.configurationWriteAllowed;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/courses/${courseId}/staff`, { email: email.trim(), role });
      setEmail('');
      staff.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>課程人員</h2>
      <ErrorAlert error={staff.error} />
      {staff.data &&
        (staff.data.length === 0 ? (
          <p className="muted">尚未指派講師或課程管理員。</p>
        ) : (
          <ul className="link-list">
            {staff.data.map((s) => (
              <li key={`${s.userId}-${s.role}`}>
                {s.displayName} <span className="muted small">{s.email}</span>・{ROLE_LABELS[s.role]}
                {s.memberDisabled && (
                  <>
                    {' '}
                    <span className="badge badge-blocked" title="此成員在本組織已停用，目前沒有這門課的權限">
                      已停用
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ))}
      <p className="muted small">對象必須已是本組織的成員。要移除人員，請到「成員管理」調整該成員的角色。</p>
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
        <fieldset disabled={!writable || busy}>
          <Field label="成員 Email">
            <input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="角色">
            <select value={role} onChange={(e) => setRole(e.target.value as CourseStaffRole)}>
              {COURSE_STAFF_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '指派中…' : '指派'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

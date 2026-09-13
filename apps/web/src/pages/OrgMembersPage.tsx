import {
  COURSE_ROLES,
  MEMBER_SEARCH_MAX,
  ORG_LEVEL_ROLES,
  type CourseDto,
  type MemberRoleDto,
  type MembershipStatus,
  type OrganizationDto,
  type OrgMemberDto,
  type OrgRole,
  type RoleSpec,
} from '@iac/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime, ROLE_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';
import { BulkImportCard } from './bulk-import';

interface MemberPage {
  data: OrgMemberDto[];
  meta: { next_cursor: string | null };
}

/** 篩選選單的順序：管理類在前、講師類居中、學員與稽核在後 */
const FILTER_ROLES: OrgRole[] = ['org_admin', 'instructor', 'course_admin', 'learner', 'auditor'];
const ADD_ROLES: OrgRole[] = ['learner', 'instructor', 'course_admin', 'org_admin', 'auditor'];
const SEARCH_DELAY_MS = 300;

/** 課程角色顯示為「講師 · C-0001 課程名稱」，一眼看出是哪門課 */
export function roleText(r: MemberRoleDto): string {
  if (!r.courseId) return ROLE_LABELS[r.role];
  return r.course ? `${ROLE_LABELS[r.role]} · ${r.course.code} ${r.course.title}` : `${ROLE_LABELS[r.role]}（課程）`;
}

/** 組織層級角色在前（依 ORG_LEVEL_ROLES 順序），課程角色在後 */
export function sortRoles(roles: MemberRoleDto[]): MemberRoleDto[] {
  const rank = (r: MemberRoleDto) => (r.courseId ? 100 : ORG_LEVEL_ROLES.indexOf(r.role));
  return [...roles].sort((a, b) => rank(a) - rank(b) || (a.course?.code ?? '').localeCompare(b.course?.code ?? ''));
}

const roleKey = (r: RoleSpec) => `${r.role}:${r.courseId ?? ''}`;

/** 組織內的課程（供指定講師時選擇）；最多取 10 頁 */
function useOrgCourses(orgId: string, enabled: boolean): { courses: CourseDto[] | null; error: unknown } {
  const [state, setState] = useState<{ courses: CourseDto[] | null; error: unknown }>({ courses: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const all: CourseDto[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 10; i++) {
          const q: URLSearchParams = new URLSearchParams({ organizationId: orgId, limit: '100', ...(cursor && { cursor }) });
          const r: { data: CourseDto[]; meta: { next_cursor: string | null } } = await api('GET', `/api/courses?${q.toString()}`, undefined, {
            signal: ac.signal,
          });
          all.push(...r.data);
          cursor = r.meta.next_cursor;
          if (!cursor) break;
        }
        setState({ courses: all, error: null });
      } catch (error) {
        if (!ac.signal.aborted) setState({ courses: null, error });
      }
    })();
    return () => ac.abort();
  }, [orgId, enabled]);
  return state;
}

/** /app/platform/organizations/:orgId/users（指定組織）與 /app/org/users（目前組織）共用 */
export function OrgMembersPage() {
  const me = useMe();
  const { orgId: routeOrgId } = useParams();
  const orgId = routeOrgId ?? me.activeOrganization?.id ?? '';
  const allowed = can(me, 'org.user.read') && orgId !== '';
  const org = useApi<OrganizationDto>(allowed && can(me, 'org.read') ? `/api/organizations/${orgId}` : null);
  useTitle(org.data ? `${org.data.name}・成員` : '成員管理');

  const [members, setMembers] = useState<OrgMemberDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<OrgRole | ''>('');
  const [statusFilter, setStatusFilter] = useState<MembershipStatus | ''>('');
  const [actionError, setActionError] = useState<unknown>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [text]);

  const load = useCallback(
    async (cursor: string | null) => {
      const mine = ++seq.current; // 輸入過程中發出的舊請求，回來時直接丟棄
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: '20' });
        if (cursor) q.set('cursor', cursor);
        if (search) q.set('q', search);
        if (roleFilter) q.set('role', roleFilter);
        if (statusFilter) q.set('status', statusFilter);
        const r = await api<MemberPage>('GET', `/api/organizations/${orgId}/users?${q.toString()}`);
        if (mine !== seq.current) return;
        setMembers((m) => (cursor ? [...m, ...r.data] : r.data));
        setNext(r.meta.next_cursor);
      } catch (e) {
        if (mine === seq.current) setError(e);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [orgId, search, roleFilter, statusFilter],
  );

  useEffect(() => {
    if (allowed) void load(null);
  }, [allowed, load]);

  const writable = me.licenseCapabilities.configurationWriteAllowed;
  const canAssign = can(me, 'org.role.assign') && writable;
  const canAdd = can(me, 'org.user.write');
  const courses = useOrgCourses(orgId, allowed && canAdd && can(me, 'course.read'));
  const canWrite = canAdd && writable;

  if (!allowed) return <Forbidden />;
  const filtered = search !== '' || roleFilter !== '' || statusFilter !== '';

  /** 停用／恢復在本組織的成員資格；角色保留，其他組織不受影響 */
  async function changeStatus(m: OrgMemberDto) {
    const next: MembershipStatus = m.membershipStatus === 'disabled' ? 'active' : 'disabled';
    if (
      next === 'disabled' &&
      !window.confirm(`確定要停用「${m.displayName}」在本組織的成員資格？\n\n他在本組織的所有權限會立即失效；角色會保留，可隨時恢復。其他組織不受影響。`)
    ) {
      return;
    }
    setActionError(null);
    try {
      const r = await api<{ membershipStatus: MembershipStatus }>(
        'POST',
        `/api/organizations/${orgId}/users/${m.id}/${next === 'disabled' ? 'disable' : 'enable'}`,
      );
      setMembers((list) => list.map((x) => (x.id === m.id ? { ...x, membershipStatus: r.membershipStatus } : x)));
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <PageHeader title={org.data ? `${org.data.name}・成員管理` : '成員管理'} subtitle="新成員會收到設定密碼的邀請信；管理員不會經手任何人的密碼。" />

      {canAdd && <AddMember orgId={orgId} writable={writable} courses={courses.courses} onAdded={() => void load(null)} />}
      {canAdd && writable && (
        <section className="card">
          <h2>批次匯入成員</h2>
          <BulkImportCard kind="members" endpoint={`/api/organizations/${orgId}/users/import`} onDone={() => void load(null)} />
        </section>
      )}

      <section className="card">
        <h2>成員</h2>
        <div className="toolbar">
          <input
            type="search"
            placeholder="搜尋姓名或 Email"
            aria-label="搜尋成員"
            maxLength={MEMBER_SEARCH_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <select aria-label="依角色篩選" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as OrgRole | '')}>
            <option value="">全部角色</option>
            {FILTER_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <select aria-label="依狀態篩選" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as MembershipStatus | '')}>
            <option value="">全部狀態</option>
            <option value="active">啟用中</option>
            <option value="disabled">已停用</option>
          </select>
        </div>
        <ErrorAlert error={error} />
        <ErrorAlert error={actionError} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>角色</th>
                <th>狀態</th>
                <th>最後登入</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  orgId={orgId}
                  isSelf={m.id === me.user.id}
                  editing={editing === m.id}
                  canAssign={canAssign}
                  canWrite={canWrite}
                  onToggleStatus={() => void changeStatus(m)}
                  onEdit={() => setEditing(editing === m.id ? null : m.id)}
                  onSaved={(roles) => {
                    setMembers((list) => list.map((x) => (x.id === m.id ? { ...x, roles } : x)));
                    setEditing(null);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
        {loading && <Spinner />}
        {!loading && members.length === 0 && !error && <p className="muted">{filtered ? '沒有符合條件的成員。' : '目前沒有成員。'}</p>}
        {next && !loading && (
          <button className="btn" onClick={() => void load(next)}>
            載入更多
          </button>
        )}
      </section>
    </>
  );
}

function MemberRow(props: {
  member: OrgMemberDto;
  orgId: string;
  isSelf: boolean;
  editing: boolean;
  canAssign: boolean;
  canWrite: boolean;
  onToggleStatus(): void;
  onEdit(): void;
  onSaved(roles: MemberRoleDto[]): void;
}) {
  const { member: m } = props;
  const disabled = m.membershipStatus === 'disabled';
  return (
    <>
      <tr>
        <td>
          <div>
            {m.displayName}
            {props.isSelf && <span className="muted small">（你）</span>}
          </div>
          <div className="muted small">{m.email}</div>
        </td>
        <td>
          {m.roles.length ? (
            <ul className="role-list">
              {sortRoles(m.roles).map((r) => (
                <li key={roleKey(r)}>{roleText(r)}</li>
              ))}
            </ul>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          {disabled ? (
            <span className="badge badge-blocked">已停用</span>
          ) : m.status === 'disabled' ? (
            <span className="badge badge-blocked" title="帳號已由平台停用，所有組織都無法登入">
              帳號停用
            </span>
          ) : m.pendingInvitation ? (
            <span className="badge badge-grace">邀請中</span>
          ) : (
            <span className="badge badge-active">啟用</span>
          )}
        </td>
        <td>{formatDateTime(m.lastLoginAt)}</td>
        <td className="actions">
          <div className="row-actions">
            {props.canAssign && (
              <button className="btn btn-small" onClick={props.onEdit} aria-expanded={props.editing}>
                {props.editing ? '取消' : '編輯角色'}
              </button>
            )}
            {props.canWrite && !props.isSelf && (
              <button className={`btn btn-small${disabled ? '' : ' btn-danger'}`} onClick={props.onToggleStatus}>
                {disabled ? '恢復' : '停用'}
              </button>
            )}
          </div>
        </td>
      </tr>
      {props.editing && (
        <tr className="row-editor">
          <td colSpan={5}>
            <RoleEditor member={m} orgId={props.orgId} isSelf={props.isSelf} onSaved={props.onSaved} onCancel={props.onEdit} />
          </td>
        </tr>
      )}
    </>
  );
}

function RoleEditor(props: { member: OrgMemberDto; orgId: string; isSelf: boolean; onSaved(roles: MemberRoleDto[]): void; onCancel(): void }) {
  const { member } = props;
  const [selected, setSelected] = useState(() => new Set(member.roles.filter((r) => !r.courseId).map((r) => r.role)));
  // 角色指派為「整組取代」：未標記移除的課程角色必須原樣送回
  const courseRoles = sortRoles(member.roles.filter((r) => r.courseId));
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 伺服器同樣會拒絕（cannot_remove_own_admin）；畫面先鎖住，避免誤按
  const ownAdminLocked = props.isSelf && member.roles.some((r) => r.role === 'org_admin');

  function toggle(role: OrgRole) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(role)) n.delete(role);
      else n.add(role);
      return n;
    });
  }

  function toggleRemoved(key: string) {
    setRemoved((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  const kept = courseRoles.filter((r) => !removed.has(roleKey(r)));
  const willLeave = selected.size === 0 && kept.length === 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const roles: RoleSpec[] = [
        ...ORG_LEVEL_ROLES.filter((r) => selected.has(r)).map((role) => ({ role })),
        ...kept.map((r) => ({ role: r.role, courseId: r.courseId! })),
      ];
      const r = await api<{ roles: MemberRoleDto[] }>('PATCH', `/api/organizations/${props.orgId}/users/${member.id}/roles`, { roles });
      props.onSaved(r.roles);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      <p>
        <strong>{member.displayName}</strong> 在此組織的角色：
      </p>
      <ErrorAlert error={error} />
      <div className="check-row">
        {ORG_LEVEL_ROLES.map((r) => (
          <label key={r} className="check">
            <input type="checkbox" checked={selected.has(r)} onChange={() => toggle(r)} disabled={busy || (r === 'org_admin' && ownAdminLocked)} />
            {ROLE_LABELS[r]}
          </label>
        ))}
      </div>
      {ownAdminLocked && <p className="muted small">不能取消自己的組織管理員角色；如需調整，請由其他組織管理員處理。</p>}

      <p className="small">課程角色：</p>
      {courseRoles.length ? (
        <div className="chip-row">
          {courseRoles.map((r) => {
            const key = roleKey(r);
            const off = removed.has(key);
            return (
              <span key={key} className={`chip${off ? ' chip-removed' : ''}`}>
                {roleText(r)}
                <button type="button" className="btn btn-small btn-ghost" onClick={() => toggleRemoved(key)} disabled={busy}>
                  {off ? '復原' : '移除'}
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="muted small">無</p>
      )}
      <p className="muted small">新增課程角色：請到該課程頁的「課程人員」指派。</p>
      {willLeave && <Notice kind="warn">沒有保留任何角色：儲存後此人將不再是本組織的成員。</Notice>}

      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? '儲存中…' : '儲存'}
        </button>
        <button className="btn btn-ghost" onClick={props.onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

function AddMember({ orgId, writable, courses, onAdded }: { orgId: string; writable: boolean; courses: CourseDto[] | null; onAdded(): void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<OrgRole>('learner');
  const [courseId, setCourseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);
  const courseRole = COURSE_ROLES.includes(role);
  // 課程角色需要課程清單（需 course.read）；沒有時不提供這兩個選項
  const roles = courses ? ADD_ROLES : ADD_ROLES.filter((r) => !COURSE_ROLES.includes(r));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const addr = email.trim();
      const r = await api<{ userId: string; invited: boolean; emailSent: boolean }>('POST', `/api/organizations/${orgId}/users`, {
        email: addr,
        displayName: displayName.trim(),
        role,
        ...(courseRole && { courseId }),
      });
      setResult(
        !r.invited
          ? `${addr} 已有帳號，已直接加入本組織。`
          : r.emailSent
            ? `已新增 ${addr}，並寄出設定密碼的邀請信。`
            : `已新增 ${addr}，但邀請信未能寄出；請對方在登入頁使用「忘記密碼」設定密碼。`,
      );
      setEmail('');
      setDisplayName('');
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>新增成員</h2>
      {!writable && <Notice kind="warn">目前的授權不允許變更設定，暫時無法新增成員。</Notice>}
      {result && <Notice kind="ok">{result}</Notice>}
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
        <fieldset disabled={!writable || busy}>
          <Field label="Email">
            <input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="姓名">
            <input required maxLength={200} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="角色" hint={courseRole ? '講師與課程管理員的權限只及於指定的課程' : undefined}>
            <select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          {courseRole && (
            <Field label="課程" hint={courses && courses.length === 0 ? '尚無課程，請先到「課程管理」建立課程' : undefined}>
              <select required value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">請選擇課程</option>
                {(courses ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '新增中…' : '新增並寄送邀請'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

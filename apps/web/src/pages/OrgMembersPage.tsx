import type { OrganizationDto, OrgMemberDto, OrgRole, RoleSpec } from '@iac/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime, ROLE_LABELS } from '../format';
import { useApi, useTitle } from '../hooks';

interface MemberPage {
  data: OrgMemberDto[];
  meta: { next_cursor: string | null };
}

/** 可在此頁直接勾選的組織層級角色；課程角色待課程管理 API 完成後提供 */
const ORG_LEVEL_ROLES: OrgRole[] = ['org_admin', 'learner', 'auditor'];

export function roleText(r: RoleSpec): string {
  return r.courseId ? `${ROLE_LABELS[r.role]}（課程）` : ROLE_LABELS[r.role];
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

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: '20' });
        if (cursor) q.set('cursor', cursor);
        const r = await api<MemberPage>('GET', `/api/organizations/${orgId}/users?${q.toString()}`);
        setMembers((m) => (cursor ? [...m, ...r.data] : r.data));
        setNext(r.meta.next_cursor);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [orgId],
  );

  useEffect(() => {
    if (allowed) void load(null);
  }, [allowed, load]);

  if (!allowed) return <Forbidden />;
  const writable = me.licenseCapabilities.configurationWriteAllowed;
  const canAssign = can(me, 'org.role.assign') && writable;

  return (
    <>
      <PageHeader title={org.data ? `${org.data.name}・成員管理` : '成員管理'} subtitle="新成員會收到設定密碼的邀請信；管理員不會經手任何人的密碼。" />

      {can(me, 'org.user.write') && <AddMember orgId={orgId} writable={writable} onAdded={() => void load(null)} />}

      <section className="card">
        <h2>成員</h2>
        <ErrorAlert error={error} />
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
                  editing={editing === m.id}
                  canAssign={canAssign}
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
        {!loading && members.length === 0 && !error && <p className="muted">目前沒有成員。</p>}
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
  editing: boolean;
  canAssign: boolean;
  onEdit(): void;
  onSaved(roles: RoleSpec[]): void;
}) {
  const { member: m } = props;
  return (
    <>
      <tr>
        <td>
          <div>{m.displayName}</div>
          <div className="muted small">{m.email}</div>
        </td>
        <td>{m.roles.length ? m.roles.map(roleText).join('、') : <span className="muted">—</span>}</td>
        <td>
          {m.status === 'disabled' ? (
            <span className="badge badge-blocked">已停用</span>
          ) : m.pendingInvitation ? (
            <span className="badge badge-grace">邀請中</span>
          ) : (
            <span className="badge badge-active">啟用</span>
          )}
        </td>
        <td>{formatDateTime(m.lastLoginAt)}</td>
        <td className="actions">
          {props.canAssign && (
            <button className="btn btn-small" onClick={props.onEdit} aria-expanded={props.editing}>
              {props.editing ? '取消' : '編輯角色'}
            </button>
          )}
        </td>
      </tr>
      {props.editing && (
        <tr className="row-editor">
          <td colSpan={5}>
            <RoleEditor member={m} orgId={props.orgId} onSaved={props.onSaved} onCancel={props.onEdit} />
          </td>
        </tr>
      )}
    </>
  );
}

function RoleEditor({ member, orgId, onSaved, onCancel }: { member: OrgMemberDto; orgId: string; onSaved(roles: RoleSpec[]): void; onCancel(): void }) {
  const [selected, setSelected] = useState(() => new Set(member.roles.filter((r) => !r.courseId).map((r) => r.role)));
  // 角色指派為「整組取代」：課程角色此處不能編輯，但必須原樣送回，否則會被清除
  const courseRoles = member.roles.filter((r) => r.courseId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function toggle(role: OrgRole) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(role)) n.delete(role);
      else n.add(role);
      return n;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const roles: RoleSpec[] = [...ORG_LEVEL_ROLES.filter((r) => selected.has(r)).map((role) => ({ role })), ...courseRoles];
      const r = await api<{ roles: RoleSpec[] }>('PATCH', `/api/organizations/${orgId}/users/${member.id}/roles`, { roles });
      onSaved(r.roles);
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
            <input type="checkbox" checked={selected.has(r)} onChange={() => toggle(r)} disabled={busy} />
            {ROLE_LABELS[r]}
          </label>
        ))}
      </div>
      {courseRoles.length > 0 && <p className="muted small">另有課程角色：{courseRoles.map(roleText).join('、')}（此處不變更）</p>}
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? '儲存中…' : '儲存'}
        </button>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

function AddMember({ orgId, writable, onAdded }: { orgId: string; writable: boolean; onAdded(): void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'learner' | 'org_admin' | 'auditor'>('learner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);

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
          <Field label="角色" hint="課程管理員與講師需指定課程，將於課程管理功能完成後開放">
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="learner">{ROLE_LABELS.learner}</option>
              <option value="org_admin">{ROLE_LABELS.org_admin}</option>
              <option value="auditor">{ROLE_LABELS.auditor}</option>
            </select>
          </Field>
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

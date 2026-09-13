import type { OrganizationDto } from '@iac/contracts';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe, useSession } from '../auth/session';
import { ErrorAlert, Field, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { formatDate } from '../format';
import { useApi, useTitle } from '../hooks';

interface CreateResult {
  organization: OrganizationDto;
  initialAdmin?: { userId: string; invited: boolean; emailSent: boolean };
}

export function OrganizationsPage() {
  const me = useMe();
  const platform = can(me, 'platform.organization.create') || can(me, 'platform.organization.disable');
  useTitle(platform ? '組織管理' : '我的組織');
  const list = useApi<OrganizationDto[]>(can(me, 'org.read') ? '/api/organizations' : null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);

  if (!can(me, 'org.read')) return <Forbidden />;
  const writable = me.licenseCapabilities.configurationWriteAllowed;

  async function toggle(org: OrganizationDto) {
    const disabling = org.status === 'active';
    if (disabling && !window.confirm(`確定要停用「${org.name}」？停用後該組織所有成員將立即無法存取。`)) return;
    setBusyId(org.id);
    setActionError(null);
    try {
      await api('POST', `/api/organizations/${org.id}/${disabling ? 'disable' : 'enable'}`);
      list.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader title={platform ? '組織管理' : '我的組織'} subtitle={platform ? '建立組織並指定首位管理員；停用後該組織的授權立即失效。' : undefined} />

      {can(me, 'platform.organization.create') && <CreateOrganization writable={writable} onCreated={list.reload} />}

      <section className="card">
        <h2>組織列表</h2>
        <ErrorAlert error={list.error ?? actionError} />
        {list.loading && !list.data ? (
          <Spinner />
        ) : list.data && list.data.length === 0 ? (
          <p className="muted">目前沒有任何組織。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>代碼</th>
                  <th>狀態</th>
                  <th>建立日期</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {list.data?.map((o) => [
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td>
                      <code>{o.code}</code>
                    </td>
                    <td>
                      <span className={`badge ${o.status === 'active' ? 'badge-active' : 'badge-blocked'}`}>{o.status === 'active' ? '啟用中' : '已停用'}</span>
                    </td>
                    <td>{formatDate(o.createdAt)}</td>
                    <td className="actions">
                      {can(me, 'org.user.read') && o.status === 'active' && <Link to={`/app/platform/organizations/${o.id}/users`}>成員</Link>}
                      {can(me, 'org.settings.write') && o.status === 'active' && <Link to={`/app/platform/organizations/${o.id}/branding`}>品牌</Link>}
                      {can(me, 'platform.organization.create') && (
                        <button className="btn btn-small btn-ghost" disabled={!writable} onClick={() => setRecovering(recovering === o.id ? null : o.id)} aria-expanded={recovering === o.id}>
                          管理員復原
                        </button>
                      )}
                      {can(me, 'platform.organization.disable') && (
                        <button className={`btn btn-small ${o.status === 'active' ? 'btn-danger' : ''}`} disabled={!writable || busyId === o.id} onClick={() => void toggle(o)}>
                          {o.status === 'active' ? '停用' : '重新啟用'}
                        </button>
                      )}
                    </td>
                  </tr>,
                  recovering === o.id && (
                    <tr key={`${o.id}-recovery`} className="row-editor">
                      <td colSpan={5}>
                        <AdminRecovery org={o} onDone={() => setRecovering(null)} />
                      </td>
                    </tr>
                  ),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/**
 * 管理員復原（ADR-033）：只在組織已沒有啟用中的管理員時可用，伺服器會拒絕其他情況。
 * 平台管理員平時無權管理組織成員——這不是繞道。
 */
function AdminRecovery({ org, onDone }: { org: OrganizationDto; onDone(): void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const addr = email.trim();
      const r = await api<{ invited: boolean; emailSent: boolean }>('POST', `/api/organizations/${org.id}/admin-recovery`, {
        email: addr,
        displayName: displayName.trim(),
      });
      setResult(
        !r.invited
          ? `${addr} 已設為「${org.name}」的組織管理員。`
          : r.emailSent
            ? `已建立 ${addr} 並寄出設定密碼邀請，對方設定後即為「${org.name}」的組織管理員。`
            : `已建立 ${addr}，但邀請信未能寄出；請對方在登入頁使用「忘記密碼」設定密碼。`,
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="editor">
      <p>
        <strong>管理員復原：{org.name}</strong>
      </p>
      <p className="muted small">只有在此組織已沒有任何啟用中的管理員時才能使用；此操作會記錄在該組織的稽核紀錄中。</p>
      {result ? (
        <>
          <Notice kind="ok">{result}</Notice>
          <button className="btn btn-small" onClick={onDone}>
            完成
          </button>
        </>
      ) : (
        <>
          <ErrorAlert error={error} />
          <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
            <fieldset disabled={busy}>
              <Field label="新管理員 Email" hint="可為新帳號或既有帳號">
                <input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="姓名" hint="僅在建立新帳號時使用">
                <input required maxLength={200} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary">
                  {busy ? '處理中…' : '指定管理員'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={onDone}>
                  取消
                </button>
              </div>
            </fieldset>
          </form>
        </>
      )}
    </div>
  );
}

function CreateOrganization({ writable, onCreated }: { writable: boolean; onCreated(): void }) {
  const { reload: reloadSession } = useSession();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [withAdmin, setWithAdmin] = useState(true);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = {
        code: code.trim(),
        name: name.trim(),
        ...(withAdmin && { initialAdmin: { email: adminEmail.trim(), displayName: adminName.trim() } }),
      };
      const r = await api<CreateResult>('POST', '/api/organizations', body);
      const a = r.initialAdmin;
      setResult(
        !a
          ? `已建立「${r.organization.name}」。`
          : !a.invited
            ? `已建立「${r.organization.name}」，${body.initialAdmin?.email} 已有帳號，已直接設為組織管理員。`
            : a.emailSent
              ? `已建立「${r.organization.name}」，並寄出設定密碼邀請給 ${body.initialAdmin?.email}。`
              : `已建立「${r.organization.name}」，但邀請信未能寄出；請對方在登入頁使用「忘記密碼」設定密碼。`,
      );
      setCode('');
      setName('');
      setAdminEmail('');
      setAdminName('');
      onCreated();
      void reloadSession();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>建立組織</h2>
      {!writable && <Notice kind="warn">目前的授權不允許變更設定，暫時無法建立組織。</Notice>}
      {result && <Notice kind="ok">{result}</Notice>}
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
        <fieldset disabled={!writable || busy}>
          <Field label="組織名稱">
            <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="代碼" hint="小寫英文、數字與連字號，2～63 字元；建立後不可變更">
            <input required pattern="[a-z0-9][a-z0-9\-]{1,62}" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={withAdmin} onChange={(e) => setWithAdmin(e.target.checked)} />
            同時指定首位組織管理員（建議；否則沒有人能新增成員）
          </label>
          {withAdmin && (
            <>
              <Field label="管理員 Email" hint="新帳號會收到設定密碼的邀請信">
                <input type="email" required maxLength={254} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
              </Field>
              <Field label="管理員姓名">
                <input required maxLength={200} value={adminName} onChange={(e) => setAdminName(e.target.value)} />
              </Field>
            </>
          )}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '建立中…' : '建立組織'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

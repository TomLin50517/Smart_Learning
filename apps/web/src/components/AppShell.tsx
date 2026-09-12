import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { can, HOME, navItems } from '../auth/permissions';
import { useSession } from '../auth/session';
import { brandColor } from '../format';
import { Spinner } from './ui';

/** 需登入的版面：未登入導向登入頁（帶 ?next= 以便登入後回到原頁） */
export function RequireAuth() {
  const { status, endedBy, reload } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <main className="boot">
        <Spinner />
      </main>
    );
  }
  if (status === 'error') {
    return (
      <main className="boot">
        <div className="card empty">
          <h1>無法連線到伺服器</h1>
          <p className="muted">請確認網路連線後再試一次。</p>
          <button className="btn btn-primary" onClick={() => void reload()}>
            重新連線
          </button>
        </div>
      </main>
    );
  }
  if (status === 'anonymous') {
    const here = location.pathname + location.search;
    const next = endedBy === 'logout' || here === HOME ? '' : `?next=${encodeURIComponent(here)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <AppShell />;
}

function AppShell() {
  const { me, logout } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const color = brandColor(me.activeOrganization?.branding);
  const style = color ? ({ '--brand': color } as CSSProperties) : undefined;

  async function onLogout() {
    setBusy(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="shell" style={style}>
      <header className="topbar">
        <Link to={HOME} className="product">
          <img src="/favicon.svg" alt="" width={24} height={24} />
          <span>互動學習平台</span>
        </Link>
        <OrgSwitcher />
        <div className="topbar-user">
          <Link to="/app/profile" className="user-name" title={`${me.user.email}（個人資料）`}>
            {me.user.displayName}
          </Link>
          <button className="btn btn-ghost" onClick={() => void onLogout()} disabled={busy}>
            登出
          </button>
        </div>
      </header>
      <nav className="sidenav" aria-label="主選單">
        {navItems(me).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end ?? false} className={({ isActive }) => (isActive ? 'active' : undefined)}>
            {n.label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <LicenseBanner />
        <Outlet />
      </main>
    </div>
  );
}

/** 只屬於一個組織時顯示名稱；多個組織時可切換（PUT /api/me/active-organization，只影響目前 session） */
function OrgSwitcher() {
  const { me, reload } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!me?.activeOrganization && !me?.organizations.length) return null;
  if (!me.organizations.length || me.organizations.length === 1) {
    return me.activeOrganization ? <span className="org-chip">{me.activeOrganization.name}</span> : null;
  }

  async function onChange(organizationId: string) {
    setBusy(true);
    setFailed(false);
    try {
      await api('PUT', '/api/me/active-organization', { organizationId });
      await reload();
      navigate(HOME);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="org-switch">
      <span className="sr-only">目前組織</span>
      <select value={me.activeOrganization?.id ?? ''} onChange={(e) => void onChange(e.target.value)} disabled={busy} aria-invalid={failed}>
        {!me.activeOrganization && <option value="">選擇組織…</option>}
        {me.organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {failed && <span className="field-error">切換失敗</span>}
    </label>
  );
}

function LicenseBanner() {
  const { me } = useSession();
  if (!me) return null;
  const { state } = me.licenseCapabilities;
  if (state === 'active') return null;
  const activate = can(me, 'platform.license.read') ? (
    <>
      {' '}
      <Link to="/app/platform/license">前往授權管理</Link>
    </>
  ) : null;
  const text: Record<Exclude<typeof state, 'active'>, string> = {
    unlicensed: '系統尚未啟用授權，新增與變更設定的功能暫停使用。',
    grace: '授權已到期，目前處於寬限期，請盡快更新授權。',
    frozen: '授權維護期已過，設定目前為唯讀；學習功能不受影響。',
    blocked: '授權無效或已停用，系統功能受限。',
  };
  return (
    <div className={`alert ${state === 'grace' || state === 'frozen' ? 'alert-warn' : 'alert-error'} banner`} role="status">
      {text[state]}
      {activate}
    </div>
  );
}

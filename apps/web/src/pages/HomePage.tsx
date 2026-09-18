import { Link } from 'react-router';
import { can, HOME, navItems } from '../auth/permissions';
import { useMe } from '../auth/session';
import { PageHeader } from '../components/ui';
import { LICENSE_STATE_LABELS } from '../format';
import { useTitle } from '../hooks';

export function HomePage() {
  useTitle('首頁');
  const me = useMe();
  const shortcuts = navItems(me).filter((n) => n.to !== HOME);
  const state = me.licenseCapabilities.state;

  return (
    <>
      <PageHeader title={`您好，${me.user.displayName}`} subtitle={me.user.email} />
      <div className="card-grid">
        <section className="card">
          <h2>目前組織</h2>
          {me.activeOrganization ? (
            <p className="big">{me.activeOrganization.name}</p>
          ) : (
            <p className="muted">{me.organizations.length ? '尚未選擇組織' : '尚未加入任何組織'}</p>
          )}
          {me.organizations.length > 1 && <p className="muted">共參與 {me.organizations.length} 個組織</p>}
        </section>

        <section className="card">
          <h2>系統授權</h2>
          <p>
            <span className={`badge badge-${state}`}>{LICENSE_STATE_LABELS[state]}</span>
          </p>
          {can(me, 'platform.license.read') && <Link to="/app/platform/license">檢視授權詳情</Link>}
        </section>

        {/* 與側邊導航同一份資料，但附上用途說明；只列出這個帳號真的能開的頁面 */}
        <section className="card shortcuts">
          <h2>可使用的功能</h2>
          {shortcuts.length ? (
            <div className="shortcut-grid">
              {shortcuts.map((s) => (
                <Link key={s.to} to={s.to} className="shortcut">
                  <strong>{s.label}</strong>
                  {s.hint && <span>{s.hint}</span>}
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">課程與學習功能將於後續版本開放。</p>
          )}
        </section>
      </div>
    </>
  );
}

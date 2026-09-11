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

        <section className="card">
          <h2>可使用的功能</h2>
          {shortcuts.length ? (
            <ul className="link-list">
              {shortcuts.map((s) => (
                <li key={s.to}>
                  <Link to={s.to}>{s.label}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">課程與學習功能將於後續版本開放。</p>
          )}
        </section>
      </div>
    </>
  );
}

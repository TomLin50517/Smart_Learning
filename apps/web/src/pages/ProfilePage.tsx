import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { passwordProblem, PASSWORD_MAX, PASSWORD_MIN } from '../auth/password';
import { can } from '../auth/permissions';
import { useMe, useSession } from '../auth/session';
import { ErrorAlert, Field, Notice, PageHeader } from '../components/ui';
import { useTitle } from '../hooks';

const LOCALES = [
  ['zh-TW', '繁體中文'],
  ['en', 'English'],
] as const;

/** /app/profile（SD §7.1、§8.12）：每個帳號都能管理自己的資料 */
export function ProfilePage() {
  useTitle('個人資料');
  const me = useMe();
  return (
    <>
      <PageHeader title="個人資料" subtitle={me.user.email} />
      <ProfileForm />
      <PasswordForm />
      {can(me, 'audit.read_self') && (
        <section className="card">
          <h2>帳號活動</h2>
          <p className="muted">查看與您帳號相關的登入、權限變更，以及誰在何時檢視過您的 AI 學習教練對話。</p>
          <Link to="/app/audit">查看帳號活動</Link>
        </section>
      )}
    </>
  );
}

function ProfileForm() {
  const me = useMe();
  const { reload } = useSession();
  const [displayName, setDisplayName] = useState(me.user.displayName);
  const [locale, setLocale] = useState(me.user.locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const patch = {
        ...(displayName.trim() !== me.user.displayName && { displayName: displayName.trim() }),
        ...(locale !== me.user.locale && { locale }),
      };
      if (Object.keys(patch).length) await api('PATCH', '/api/me/profile', patch);
      setDone(true);
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>基本資料</h2>
      {done && <Notice kind="ok">已儲存。</Notice>}
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)}>
        <fieldset disabled={busy}>
          <Field label="顯示名稱">
            <input required maxLength={200} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="語言" hint="系統寄給您的信件會使用此語言">
            <select value={locale} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '儲存中…' : '儲存'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const problem = passwordProblem(next, confirm);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (problem || !current) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api('POST', '/api/me/password', { currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>變更密碼</h2>
      {done && <Notice kind="ok">密碼已變更。其他裝置上的登入已一併登出。</Notice>}
      <ErrorAlert error={error} />
      <form className="form-grid" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset disabled={busy}>
          <Field label="目前的密碼">
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="新密碼" hint={`${PASSWORD_MIN}～${PASSWORD_MAX} 個字元`}>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="再次輸入新密碼" error={touched ? problem : null}>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onBlur={() => setTouched(true)} />
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              {busy ? '變更中…' : '變更密碼'}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

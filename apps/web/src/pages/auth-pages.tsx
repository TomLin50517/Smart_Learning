import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import { PASSWORD_MAX, PASSWORD_MIN, passwordProblem } from '../auth/password';
import { safeNext } from '../auth/redirect';
import { useSession } from '../auth/session';
import { AuthLayout, ErrorAlert, Field, Notice } from '../components/ui';
import { useTitle } from '../hooks';

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------
export function LoginPage() {
  useTitle('登入');
  const { status, endedBy, login } = useSession();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'), '/app');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to={next} replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="登入">
      {endedBy === 'expired' && !error && <Notice kind="info">登入已逾時，請重新登入。</Notice>}
      {endedBy === 'logout' && !error && <Notice kind="ok">您已登出。</Notice>}
      {/* 伺服器對所有登入失敗回同一訊息（不透露帳號是否存在），這裡也維持一致 */}
      <ErrorAlert error={error} overrides={{ UNAUTHENTICATED: 'Email 或密碼錯誤。', VALIDATION_FAILED: '請輸入有效的 Email 與密碼。' }} />
      <form className="stack" onSubmit={(e) => void onSubmit(e)}>
        <Field label="Email">
          <input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="密碼">
          <input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '登入中…' : '登入'}
        </button>
      </form>
      <p className="auth-links">
        <Link to="/forgot-password">忘記密碼？</Link>
      </p>
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
// 忘記密碼：一律顯示相同結果，不透露帳號是否存在（THR-S-001）
// ---------------------------------------------------------------------------
export function ForgotPasswordPage() {
  useTitle('忘記密碼');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/password-reset/request', { email: email.trim() }, { quiet401: true });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="忘記密碼">
      {sent ? (
        <>
          <Notice kind="ok">
            如果 <strong>{email.trim()}</strong> 是已註冊的帳號，我們已寄出密碼重設連結。請查看信箱（包含垃圾郵件匣），並在連結有效期限內完成設定。
          </Notice>
          <p className="auth-links">
            <Link to="/login">返回登入</Link>
          </p>
        </>
      ) : (
        <>
          <p className="muted">輸入您的帳號 Email，我們會寄送重設密碼的連結給您。</p>
          <ErrorAlert error={error} />
          <form className="stack" onSubmit={(e) => void onSubmit(e)}>
            <Field label="Email">
              <input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? '送出中…' : '寄送重設連結'}
            </button>
          </form>
          <p className="auth-links">
            <Link to="/login">返回登入</Link>
          </p>
        </>
      )}
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
// 重設密碼（reset）／受邀設定密碼（invite）：共用同一個 confirm 端點
// ---------------------------------------------------------------------------
export function SetPasswordPage({ mode }: { mode: 'reset' | 'invite' }) {
  const invite = mode === 'invite';
  useTitle(invite ? '設定密碼' : '重設密碼');
  const [params, setParams] = useSearchParams();
  // token 讀出後立即從網址列移除：不留在瀏覽紀錄、書籤或截圖中
  const [token] = useState(() => params.get('token'));
  useEffect(() => {
    if (params.has('token')) setParams({}, { replace: true });
  }, [params, setParams]);

  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const problem = passwordProblem(pw, confirm);
  const title = invite ? '設定您的密碼' : '重設密碼';

  if (!token) {
    return (
      <AuthLayout title={title}>
        <div className="alert alert-error" role="alert">
          <p>連結不完整或已失效。</p>
        </div>
        <p className="auth-links">
          <Link to="/forgot-password">重新取得連結</Link> · <Link to="/login">返回登入</Link>
        </p>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout title={title}>
        <Notice kind="ok">密碼已設定完成，請使用新密碼登入。{!invite && '其他裝置上的登入已一併登出。'}</Notice>
        <Link className="btn btn-primary btn-block" to="/login">
          前往登入
        </Link>
      </AuthLayout>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/password-reset/confirm', { token, newPassword: pw }, { quiet401: true });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const tokenInvalid = error instanceof ApiError && error.code === 'PASSWORD_RESET_TOKEN_INVALID';

  return (
    <AuthLayout title={title}>
      {invite && <p className="muted">歡迎加入！請設定登入用的密碼。</p>}
      <ErrorAlert error={error} />
      {tokenInvalid ? (
        <p className="auth-links">
          <Link to="/forgot-password">重新取得連結</Link>
        </p>
      ) : (
        <form className="stack" onSubmit={(e) => void onSubmit(e)} noValidate>
          <Field label="新密碼" hint={`${PASSWORD_MIN}～${PASSWORD_MAX} 個字元；建議使用容易記住的長句`}>
            <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </Field>
          <Field label="再次輸入新密碼" error={touched ? problem : null}>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onBlur={() => setTouched(true)} />
          </Field>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? '設定中…' : '設定密碼'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

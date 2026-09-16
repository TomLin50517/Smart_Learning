import { DEFAULT_PLATFORM_NAME, type ResolvedBrandingDto } from '@iac/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { describeError, ERROR_MESSAGES, type ClientErrorCode, ApiError } from '../api/errors';
import { brandStyle } from '../branding';

export function ErrorAlert({ error, overrides }: { error: unknown; overrides?: Partial<Record<ClientErrorCode, string>> }) {
  if (!error) return null;
  const d = describeError(error);
  const message = error instanceof ApiError ? (overrides?.[error.code] ?? d.message) : d.message;
  return (
    <div className="alert alert-error" role="alert">
      <p>{message}</p>
      {d.details.length > 0 && (
        <ul>
          {d.details.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {d.reference && <p className="ref">追蹤代碼：{d.reference}</p>}
    </div>
  );
}

export function Notice({ kind, children }: { kind: 'ok' | 'warn' | 'info' | 'error'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Spinner({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner-dot" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Forbidden() {
  return (
    <section className="card empty">
      <h1>無法存取</h1>
      <p className="muted">{ERROR_MESSAGES.PERMISSION_DENIED}</p>
      <Link to="/app">回到首頁</Link>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** 登入等未登入頁面的版面；brand：組織登入網址（/o/{code}）時的組織品牌 */
export function AuthLayout({ title, children, brand }: { title: string; children: ReactNode; brand?: Pick<ResolvedBrandingDto, 'platformName' | 'logoUrl' | 'colors'> | null }) {
  return (
    <main className="auth-page" {...(brand && { 'data-brand': '' })} style={brandStyle(brand)}>
      <div className="auth-card">
        {brand?.logoUrl ? (
          <img className="auth-logo" src={brand.logoUrl} alt={brand.platformName} />
        ) : (
          <div className="brand-mark" aria-hidden="true">
            <img src="/favicon.svg" alt="" width={36} height={36} />
          </div>
        )}
        <p className="auth-product">{brand?.platformName ?? DEFAULT_PLATFORM_NAME}</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

import type { MyCertificateDto } from '@iac/contracts';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiDownload, saveBlob } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert, Forbidden, Notice, PageHeader, Spinner } from '../components/ui';
import { CERTIFICATE_STATUS_BADGE, CERTIFICATE_STATUS_LABELS, formatDate } from '../format';
import { useApi, useTitle } from '../hooks';
import { CertificateView, verifyUrl } from './certificate-view';

/** /app/certificates：我的證書（UC-CRT-002、SD §6.14） */
export function MyCertificatesPage() {
  useTitle('我的證書');
  const me = useMe();
  const allowed = can(me, 'certificate.read_self');
  const list = useApi<MyCertificateDto[]>(allowed ? '/api/me/certificates' : null);

  if (!allowed) return <Forbidden />;
  return (
    <>
      <PageHeader title="我的證書" subtitle="完成課程後由系統自動發出；可以列印，或把查驗連結分享給需要確認的人。" />
      <ErrorAlert error={list.error} />
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.length === 0 && (
        <section className="card">
          <p className="muted">還沒有證書。完成課程後會出現在這裡。</p>
        </section>
      )}
      <div className="card-grid">
        {(list.data ?? []).map((c) => (
          <section key={c.id} className="card">
            <p className="muted small">{c.organizationName}</p>
            <h2>{c.courseTitle}</h2>
            <p>
              <span className={`badge ${CERTIFICATE_STATUS_BADGE[c.status]}`}>{CERTIFICATE_STATUS_LABELS[c.status]}</span>{' '}
              <span className="muted small">發證：{formatDate(c.issuedAt)}</span>
            </p>
            <p className="muted small">
              證書編號 <code>{c.publicId}</code>
            </p>
            <Link className="btn btn-primary" to={`/app/certificates/${c.id}`}>
              查看證書
            </Link>
          </section>
        ))}
      </div>
    </>
  );
}

/** /app/certificates/:certificateId：網頁版證書（列印／另存 PDF）與查驗連結 */
export function MyCertificatePage() {
  const { certificateId = '' } = useParams();
  const me = useMe();
  const allowed = can(me, 'certificate.read_self');
  const cert = useApi<MyCertificateDto>(allowed ? `/api/me/certificates/${certificateId}` : null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useTitle(cert.data ? `${cert.data.courseTitle} 證書` : '證書');

  if (!allowed) return <Forbidden />;
  if (!cert.data) return cert.loading ? <Spinner /> : <ErrorAlert error={cert.error} />;
  const c = cert.data;
  const url = verifyUrl(c.verificationCode);

  /** 伺服器產生的 PDF（SD §6.28）：內容與這一頁相同，含查驗 QR code */
  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const { blob, filename } = await apiDownload('GET', `/api/me/certificates/${certificateId}/pdf`);
      saveBlob(blob, filename);
    } catch (e) {
      setError(e);
    } finally {
      setDownloading(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt('複製這個查驗連結：', url);
    }
  }

  return (
    <>
      <PageHeader title="證書" subtitle={c.courseTitle} actions={<Link to="/app/certificates">← 我的證書</Link>} />
      {c.status === 'revoked' && (
        <Notice kind="warn">
          這張證書已於 {formatDate(c.revokedAt)} 撤銷{c.revokeReason ? `（原因：${c.revokeReason}）` : ''}。
        </Notice>
      )}
      <ErrorAlert error={error} />
      <CertificateView c={c} verifyUrl={url} />
      <div className="row no-print">
        <button type="button" className="btn btn-primary" disabled={downloading} onClick={() => void download()}>
          {downloading ? '準備中…' : '下載 PDF'}
        </button>
        <button type="button" className="btn" onClick={() => window.print()}>
          列印
        </button>
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied ? '已複製查驗連結' : '複製查驗連結'}
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          開啟查驗頁
        </a>
      </div>
    </>
  );
}

import type { PublicCertificateDto } from '@iac/contracts';
import { useParams } from 'react-router';
import { ApiError } from '../api/errors';
import { ErrorAlert, Notice, Spinner } from '../components/ui';
import { formatDate } from '../format';
import { useApi, useTitle } from '../hooks';
import { CertificateView } from './certificate-view';

/** /verify/:code：公開查驗證書（不需登入；UC-CRT-005、SD §6.14） */
export function VerifyPage() {
  const { code = '' } = useParams();
  useTitle('證書查驗');
  const r = useApi<PublicCertificateDto>(`/public/certificates/${encodeURIComponent(code)}`);
  const notFound = r.error instanceof ApiError && r.error.status === 404;

  return (
    <main className="verify-page">
      <header className="verify-head">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <strong>互動學習平台・證書查驗</strong>
      </header>
      {r.loading && !r.data && <Spinner />}
      {notFound && <Notice kind="warn">查無此證書。請確認查驗連結或驗證碼是否完整。</Notice>}
      {!notFound && <ErrorAlert error={r.error} />}
      {r.data && (
        <>
          {r.data.status === 'valid' && <Notice kind="ok">✓ 這張證書有效。</Notice>}
          {r.data.status === 'revoked' && <Notice kind="warn">這張證書已於 {formatDate(r.data.revokedAt)} 撤銷，不再有效。</Notice>}
          {r.data.status === 'expired' && <Notice kind="warn">這張證書已過期（有效期限 {formatDate(r.data.validUntil)}）。</Notice>}
          <CertificateView c={r.data} verifyUrl={null} />
          <p className="muted small">查驗結果以本系統的紀錄為準，不以證書影本或 PDF 的內容為準。</p>
        </>
      )}
    </main>
  );
}

import type { CertificateStatus } from '@iac/contracts';
import { formatDate } from '../format';

/** 查驗連結（SD §6.14）：任何人開啟即可確認證書真偽，不需登入 */
export const verifyUrl = (code: string): string => `${window.location.origin}/verify/${code}`;

interface Printable {
  status: CertificateStatus;
  publicId: string;
  organizationName: string;
  courseTitle: string;
  learnerDisplayName: string;
  issuedAt: string | null;
  versionNo?: number;
}

/** 網頁版證書（可用瀏覽器列印／另存 PDF）；撤銷或過期時蓋上戳記 */
export function CertificateView({ c, verifyUrl: url }: { c: Printable; verifyUrl: string | null }) {
  return (
    <article className={`certificate${c.status === 'valid' ? '' : ' certificate-void'}`} aria-label="結業證書">
      <p className="certificate-org">{c.organizationName}</p>
      <h1>結業證書</h1>
      <p>茲證明</p>
      <p className="certificate-name">{c.learnerDisplayName}</p>
      <p>已完成課程</p>
      <p className="certificate-course">
        {c.courseTitle}
        {c.versionNo !== undefined && <span className="muted small">（第 {c.versionNo} 版）</span>}
      </p>
      <p>發證日期：{formatDate(c.issuedAt)}</p>
      <footer className="certificate-foot">
        <span>證書編號：{c.publicId}</span>
        {url && <span>查驗：{url}</span>}
      </footer>
      {c.status !== 'valid' && (
        <p className="certificate-stamp" aria-hidden="true">
          {c.status === 'revoked' ? '已撤銷' : '已失效'}
        </p>
      )}
    </article>
  );
}

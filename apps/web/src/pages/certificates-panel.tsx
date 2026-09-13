import type { CourseCertificateDto, CourseDetailDto } from '@iac/contracts';
import { useState } from 'react';
import { api } from '../api/client';
import { can } from '../auth/permissions';
import { useMe } from '../auth/session';
import { ErrorAlert } from '../components/ui';
import { CERTIFICATE_STATUS_BADGE, CERTIFICATE_STATUS_LABELS, formatDate } from '../format';
import { useApi } from '../hooks';

/** 課程頁的「證書」卡片（UC-CRT-003/004、SD §6.14）：已發出的證書與撤銷 */
export function CertificatesPanel({ course }: { course: CourseDetailDto }) {
  const me = useMe();
  const list = useApi<CourseCertificateDto[]>(`/api/courses/${course.id}/certificates`);
  const [error, setError] = useState<unknown>(null);
  const canRevoke = can(me, 'certificate.revoke');

  async function revoke(c: CourseCertificateDto) {
    const reason = window.prompt(`撤銷「${c.learnerDisplayName}」的證書？\n撤銷後查驗會顯示「已撤銷」，證書紀錄仍會保留。\n\n請輸入撤銷原因：`)?.trim();
    if (!reason) return;
    setError(null);
    try {
      await api('POST', `/api/certificates/${c.id}/revoke`, { reason });
      list.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="card">
      <h2>證書</h2>
      <p className="muted small">學員完成課程後由系統自動發出。</p>
      <ErrorAlert error={error} />
      <ErrorAlert error={list.error} />
      {list.data && list.data.length === 0 ? (
        <p className="muted">尚未發出證書。</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>學員</th>
                <th>證書編號</th>
                <th>發證日期</th>
                <th>狀態</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>
                    <div>{c.learnerDisplayName}</div>
                    <div className="muted small">{c.learnerEmail}</div>
                  </td>
                  <td>
                    <code>{c.publicId}</code>
                  </td>
                  <td>{formatDate(c.issuedAt)}</td>
                  <td>
                    <span className={`badge ${CERTIFICATE_STATUS_BADGE[c.status]}`}>{CERTIFICATE_STATUS_LABELS[c.status]}</span>
                    {c.revokeReason && <div className="muted small">原因：{c.revokeReason}</div>}
                  </td>
                  <td className="actions">
                    {canRevoke && c.status === 'valid' && (
                      <button type="button" className="btn btn-small btn-danger" onClick={() => void revoke(c)}>
                        撤銷
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

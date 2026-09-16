import { CERTIFICATE_JOB, certificateObjectKey } from '@iac/contracts';
import type pg from 'pg';
import { renderCertificatePdf } from '../certificate-pdf.js';
import type { Job, JobHandler } from '../dispatcher.js';
import { newUlid, verificationCode } from '../ids.js';
import { notifyTx } from '../notify.js';
import { FatalError } from '../retry-policy.js';
import type { ObjectStorage } from '../storage.js';

/**
 * 發證（UC-CRT-001、SEQ-10、SD §6.14）：選課完成時由 API 在同一交易排入（idempotency key cert:{enrollmentId}）。
 * 冪等：只發給已完成的選課；已有有效或已撤銷的證書就結束（撤銷後不自動重發）；部分唯一索引 uq_cert_enr_valid 為最後防線。
 * 顯示欄位（姓名、課程、組織）為發證當下的快照。證書、學習事件與稽核在同一交易。
 * 發證時在同一交易通知學員（certificate.issued，SD §6.26），並產生 PDF 存入物件儲存（pdf_object_key，SD §6.28）。
 * PDF 或物件儲存失敗 → 整筆交易回滾、job 重試；不會留下沒有 PDF 的證書。
 */
export class CertificateGenerateHandler implements JobHandler {
  readonly jobType = CERTIFICATE_JOB.type;
  readonly timeoutMs = 60_000;

  constructor(
    private readonly db: pg.Pool,
    private readonly storage: ObjectStorage,
    private readonly opts: { fontPath: string; baseUrl: string },
  ) {}

  async handle(job: Job): Promise<void> {
    const enrollmentId = job.payload['enrollmentId'];
    if (typeof enrollmentId !== 'string') throw new FatalError('certificate.generate: payload.enrollmentId is missing');
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const e = await c.query<{
        status: string;
        organization_id: string;
        course_id: string;
        course_version_id: string;
        user_id: string;
        display_name: string;
        title: string;
        org_name: string;
        storage_prefix: string;
      }>(
        `SELECT e.status, e.organization_id, e.course_id, e.course_version_id, e.user_id, u.display_name, co.title, o.name AS org_name, o.storage_prefix
           FROM enrollments e
           JOIN users u ON u.id = e.user_id
           JOIN courses co ON co.id = e.course_id
           JOIN organizations o ON o.id = e.organization_id
          WHERE e.id = $1`,
        [enrollmentId],
      );
      const enr = e.rows[0];
      if (!enr) throw new FatalError(`certificate.generate: enrollment ${enrollmentId} not found`);
      if (enr.status !== 'completed') {
        await c.query('COMMIT');
        return;
      }
      const code = verificationCode();
      const ins = await c.query<{ id: string; public_id: string; issued_at: Date }>(
        `INSERT INTO certificates (organization_id, enrollment_id, course_version_id, public_id, verification_code, status,
                                   learner_display_name, course_title, organization_name, issued_at, valid_from)
         SELECT $1, $2, $3, $4, $5, 'valid', $6, $7, $8, now(), now()
          WHERE NOT EXISTS (SELECT 1 FROM certificates WHERE enrollment_id = $2 AND status IN ('valid', 'revoked'))
         ON CONFLICT DO NOTHING
         RETURNING id, public_id, issued_at`,
        [enr.organization_id, enrollmentId, enr.course_version_id, newUlid(), code, enr.display_name, enr.title, enr.org_name],
      );
      const cert = ins.rows[0];
      if (cert) {
        // 證書 PDF（SD §6.28）：內容與網頁版一致，含查驗網址與 QR code
        const pdf = await renderCertificatePdf(
          {
            organizationName: enr.org_name,
            courseTitle: enr.title,
            learnerDisplayName: enr.display_name,
            publicId: cert.public_id,
            issuedAt: cert.issued_at,
            verifyUrl: `${this.opts.baseUrl.replace(/\/+$/, '')}/verify/${code}`,
          },
          this.opts.fontPath,
        );
        const key = certificateObjectKey({ prefix: enr.storage_prefix, organizationId: enr.organization_id, certificateId: cert.id });
        await this.storage.put(key, pdf, { contentType: 'application/pdf', contentLength: pdf.length });
        await c.query(`UPDATE certificates SET pdf_object_key = $2 WHERE id = $1`, [cert.id, key]);
        await c.query(
          `INSERT INTO learning_events (event_id, event_type, organization_id, course_id, course_version_id, enrollment_id, learner_id, occurred_at, correlation_id, payload)
           VALUES (gen_random_uuid(), 'certificate.issued', $1, $2, $3, $4, $5, now(), $6, $7::jsonb)`,
          [enr.organization_id, enr.course_id, enr.course_version_id, enrollmentId, enr.user_id, job.correlation_id, JSON.stringify({ certificate_id: cert.id, public_id: cert.public_id })],
        );
        await c.query(
          `INSERT INTO audit_logs (actor_role, action, resource_type, resource_id, organization_id, course_id, metadata, correlation_id)
           VALUES ('system', 'certificate.issued', 'certificate', $1, $2, $3, $4::jsonb, $5)`,
          [cert.id, enr.organization_id, enr.course_id, JSON.stringify({ enrollment_id: enrollmentId, public_id: cert.public_id, job_id: job.id }), job.correlation_id],
        );
        await notifyTx(c, {
          userIds: [enr.user_id],
          organizationId: enr.organization_id,
          type: 'certificate.issued',
          payload: { organizationName: enr.org_name, courseId: enr.course_id, courseTitle: enr.title, enrollmentId, certificateId: cert.id },
          correlationId: job.correlation_id,
        });
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}

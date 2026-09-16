import { Inject, Injectable } from '@nestjs/common';
import {
  VERIFICATION_CODE_PATTERN,
  type CertificateDto,
  type CertificateStatus,
  type CourseCertificateDto,
  type MyCertificateDto,
  type PublicCertificateDto,
} from '@iac/contracts';
import pg from 'pg';
import { DB_API } from '../../../common/database.module.js';
import { DomainError } from '../../../common/domain-error.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../common/object-storage.js';
import { LEARNING_EVENTS, type LearningEventWriter } from '../../learning-record/learning-record.contracts.js';

interface Row {
  id: string;
  public_id: string;
  status: CertificateStatus;
  enrollment_id: string;
  course_id: string;
  learner_display_name: string;
  course_title: string;
  organization_name: string;
  version_no: number;
  issued_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  verification_code: string;
  learner_email: string;
}

const SELECT = `
  SELECT c.id, c.public_id, c.status, c.enrollment_id, e.course_id, c.learner_display_name, c.course_title, c.organization_name,
         cv.version_no, c.issued_at, c.revoked_at, c.revoke_reason, c.verification_code, u.email::text AS learner_email
    FROM certificates c
    JOIN enrollments e ON e.id = c.enrollment_id
    JOIN course_versions cv ON cv.id = c.course_version_id
    JOIN users u ON u.id = e.user_id`;
/** 學員與課程人員看得到的狀態（pending／failed 為 worker 的中間狀態） */
const VISIBLE = `c.status IN ('valid', 'revoked', 'expired')`;

function toDto(r: Row): CertificateDto {
  return {
    id: r.id,
    publicId: r.public_id,
    status: r.status,
    enrollmentId: r.enrollment_id,
    courseId: r.course_id,
    learnerDisplayName: r.learner_display_name,
    courseTitle: r.course_title,
    organizationName: r.organization_name,
    versionNo: r.version_no,
    issuedAt: r.issued_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokeReason: r.revoke_reason,
  };
}

/**
 * 證書（UC-CRT-002～005、SEQ-11、SD §6.14）。發證在 worker（certificate.generate）；這裡是查詢、撤銷、公開驗證。
 * 撤銷只改狀態，證書紀錄保留（ARCH §17.4）。
 */
@Injectable()
export class CertificateService {
  constructor(
    @Inject(DB_API) private readonly db: pg.Pool,
    @Inject(LEARNING_EVENTS) private readonly events: LearningEventWriter,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * 證書 PDF（UC-CRT-002、SD §6.28）：發證時由 worker 產生並存入物件儲存，這裡只取出來給下載。
   * 學員限本人（scope.userId）；課程人員經 certificate.read_all 的路由。還沒有 PDF（物件儲存當時不可用）→ 422 `pdf_not_ready`。
   */
  async pdf(id: string, scope: { userId?: string }): Promise<{ body: Buffer; filename: string }> {
    const params: unknown[] = [id];
    if (scope.userId) params.push(scope.userId);
    const r = await this.db.query<{ public_id: string; pdf_object_key: string | null }>(
      `SELECT c.public_id, c.pdf_object_key FROM certificates c JOIN enrollments e ON e.id = c.enrollment_id
        WHERE c.id = $1 AND ${VISIBLE} ${scope.userId ? 'AND e.user_id = $2' : ''}`,
      params,
    );
    const x = r.rows[0];
    if (!x) throw new DomainError('NOT_FOUND');
    if (!x.pdf_object_key) throw new DomainError('VALIDATION_FAILED', 'pdf_not_ready', [{ issue: 'pdf_not_ready' }]);
    return { body: await this.storage.get(x.pdf_object_key), filename: `certificate-${x.public_id}.pdf` };
  }

  async mine(userId: string): Promise<MyCertificateDto[]> {
    const r = await this.db.query<Row>(`${SELECT} WHERE e.user_id = $1 AND ${VISIBLE} ORDER BY c.issued_at DESC NULLS LAST LIMIT 200`, [userId]);
    return r.rows.map((x) => ({ ...toDto(x), verificationCode: x.verification_code }));
  }

  /** 自己的一張證書；不是本人的一律 404 */
  async myOne(id: string, userId: string): Promise<MyCertificateDto> {
    const r = await this.db.query<Row>(`${SELECT} WHERE c.id = $1 AND e.user_id = $2 AND ${VISIBLE}`, [id, userId]);
    const x = r.rows[0];
    if (!x) throw new DomainError('NOT_FOUND');
    return { ...toDto(x), verificationCode: x.verification_code };
  }

  /** 課程的證書（課程人員）：不含驗證碼 */
  async forCourse(courseId: string): Promise<CourseCertificateDto[]> {
    const r = await this.db.query<Row>(`${SELECT} WHERE e.course_id = $1 AND ${VISIBLE} ORDER BY c.issued_at DESC NULLS LAST LIMIT 500`, [courseId]);
    return r.rows.map((x) => ({ ...toDto(x), learnerEmail: x.learner_email }));
  }

  /** 撤銷（UC-CRT-004）：只有有效的證書可以撤銷；同一交易寫入 certificate.revoked 學習事件 */
  async revoke(id: string, actorId: string, reason: string): Promise<CourseCertificateDto> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const cur = await c.query<{ status: CertificateStatus; enrollment_id: string; public_id: string }>(
        `SELECT status, enrollment_id, public_id FROM certificates WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const x = cur.rows[0];
      if (!x) throw new DomainError('NOT_FOUND');
      if (x.status !== 'valid') throw new DomainError('VALIDATION_FAILED', 'Only valid certificates can be revoked', [{ issue: 'not_revocable', params: { status: x.status } }]);
      await c.query(`UPDATE certificates SET status = 'revoked', revoked_at = now(), revoke_reason = $2, revoked_by = $3 WHERE id = $1`, [id, reason, actorId]);
      await this.events.recordTx(c, x.enrollment_id, [{ eventType: 'certificate.revoked', payload: { certificate_id: id, public_id: x.public_id } }]);
      const after = await c.query<Row>(`${SELECT} WHERE c.id = $1`, [id]);
      await c.query('COMMIT');
      const row = after.rows[0]!;
      return { ...toDto(row), learnerEmail: row.learner_email };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * 公開驗證（UC-CRT-005）：只回證書上印的資料。驗證碼格式不符直接 404（格式不是祕密）；
   * 以唯一索引查詢，找不到與找到的路徑相同，不透露是否曾經存在。
   */
  async verify(code: string): Promise<PublicCertificateDto> {
    if (!VERIFICATION_CODE_PATTERN.test(code)) throw new DomainError('NOT_FOUND');
    const r = await this.db.query<{
      status: CertificateStatus;
      public_id: string;
      organization_name: string;
      course_title: string;
      learner_display_name: string;
      issued_at: Date;
      valid_until: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT status, public_id, organization_name, course_title, learner_display_name, issued_at, valid_until, revoked_at
         FROM certificates WHERE verification_code = $1 AND status IN ('valid', 'revoked', 'expired') AND issued_at IS NOT NULL`,
      [code],
    );
    const x = r.rows[0];
    if (!x) throw new DomainError('NOT_FOUND');
    const expired = x.status === 'expired' || (x.status === 'valid' && x.valid_until !== null && x.valid_until.getTime() < Date.now());
    return {
      status: x.status === 'revoked' ? 'revoked' : expired ? 'expired' : 'valid',
      publicId: x.public_id,
      organizationName: x.organization_name,
      courseTitle: x.course_title,
      learnerDisplayName: x.learner_display_name,
      issuedAt: x.issued_at.toISOString(),
      ...(x.valid_until && { validUntil: x.valid_until.toISOString() }),
      ...(x.revoked_at && { revokedAt: x.revoked_at.toISOString() }),
    };
  }
}

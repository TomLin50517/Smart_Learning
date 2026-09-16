/** 證書（SA §5.10 UC-CRT、SEQ-10/11；SD §6.14） */

export const CERTIFICATE_STATUSES = ['pending', 'valid', 'revoked', 'expired', 'failed'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/** 發證 job（SD §11.1）：選課完成時於同一交易排入，由 worker 的 output 佇列執行；同一筆選課只排一次 */
export const CERTIFICATE_JOB = { type: 'certificate.generate', queue: 'output', priority: 50, maxAttempts: 5 } as const;
export const certificateJobKey = (enrollmentId: string): string => `cert:${enrollmentId}`;

/** 證書 PDF 的物件 key（SD §5.1）：不含姓名或課程名稱 */
export const certificateObjectKey = (p: { prefix: string; organizationId: string; certificateId: string }): string =>
  `${p.prefix}/certificates/${p.organizationId}/${p.certificateId}.pdf`;

/** 驗證碼：20 bytes 隨機值的 base32（32 字元、160 bits，不可猜測） */
export const VERIFICATION_CODE_PATTERN = /^[A-Z2-7]{32}$/;

export interface CertificateDto {
  id: string;
  /** 對外顯示的證書編號（ULID） */
  publicId: string;
  status: CertificateStatus;
  enrollmentId: string;
  courseId: string;
  /** 以下為發證當下的快照——日後改名不影響已發的證書 */
  learnerDisplayName: string;
  courseTitle: string;
  organizationName: string;
  versionNo: number;
  issuedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

/** 學員自己的證書：含驗證碼（分享給他人查驗用） */
export interface MyCertificateDto extends CertificateDto {
  verificationCode: string;
}

/** 課程的證書清單（課程人員） */
export interface CourseCertificateDto extends CertificateDto {
  learnerEmail: string;
}

/** 公開驗證（不需登入）：刻意精簡——不含分數、email、選課 id 或任何學習紀錄（ARCH §17.3） */
export interface PublicCertificateDto {
  status: 'valid' | 'revoked' | 'expired';
  publicId: string;
  organizationName: string;
  courseTitle: string;
  learnerDisplayName: string;
  issuedAt: string;
  validUntil?: string;
  revokedAt?: string;
}

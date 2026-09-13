/** 選課（SA §7.2、UC-ENR-*；SD §2.4、§6.8） */

export const ENROLLMENT_STATUSES = ['pending', 'active', 'suspended', 'completed', 'reopened', 'withdrawn', 'rejected'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** 可學習的狀態（SA §7.2 狀態表） */
export const LEARNABLE_STATUSES: readonly EnrollmentStatus[] = ['active', 'reopened'];

export const ENROLL_METHODS = ['assign', 'self', 'code', 'approval'] as const;
export type EnrollMethod = (typeof ENROLL_METHODS)[number];

export interface EnrollmentDto {
  id: string;
  organizationId: string;
  courseId: string;
  /** 綁定的課程版本（加入當下的已發布版本，AC-CRS-003） */
  courseVersionId: string;
  versionNo: number;
  userId: string;
  status: EnrollmentStatus;
  enrollMethod: EnrollMethod;
  enrolledAt: string;
  completedAt: string | null;
  withdrawnAt: string | null;
  dueDate: string | null;
}

/** 學員自己的選課（我的課程） */
export interface MyEnrollmentDto extends EnrollmentDto {
  course: { code: string; title: string };
  organizationName: string;
  /** 狀態為 active／reopened */
  canLearn: boolean;
}

/** 課程的學員名單 */
export interface CourseLearnerDto extends EnrollmentDto {
  displayName: string;
  email: string;
  /** 在課程所屬組織的成員資格已停用 */
  memberDisabled: boolean;
}

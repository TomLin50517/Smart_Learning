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
  /** 最近一次送出作答時的進度快照；尚未作答為 null */
  progress: { requiredCompleted: number; requiredTotal: number; weightedScore: number | null } | null;
  /** 最後一筆學習事件的時間 */
  lastActivityAt: string | null;
  /** 學號／員工編號（目前） */
  memberNo: string | null;
  /** 選課時所在的班級（快照；多個以「、」連接） */
  cohortLabel: string | null;
}

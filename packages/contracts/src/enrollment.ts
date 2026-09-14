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

/**
 * 選課政策（SD §6.24、SA UC-ENR-002～004；存於 courses.enrollment_policy）。
 * joinBy：assign＝只由管理者指派（預設）；code＝學員輸入選課碼；catalog＝公開於組織的課程目錄。
 * requireApproval：學員加入後為「待審核」，由課程管理員核准。
 */
export const JOIN_BY = ['assign', 'code', 'catalog'] as const;
export type JoinBy = (typeof JOIN_BY)[number];

/** 選課碼：8 碼，不含 0／O、1／I（伺服器產生，DB CHECK 同規則） */
export const ENROLLMENT_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export interface EnrollmentPolicyDto {
  joinBy: JoinBy;
  requireApproval: boolean;
  /** joinBy = code 時的選課碼；其他方式為 null（改方式時舊碼立即失效） */
  code: string | null;
  /** 開放加入的期間（null＝不限） */
  opensAt: string | null;
  closesAt: string | null;
  /** 名額（自行加入與申請受限；管理者指派不受限）；null＝不限 */
  maxSeats: number | null;
}

/** GET /courses/{id}/enrollment-policy */
export interface EnrollmentPolicyViewDto extends EnrollmentPolicyDto {
  /** 占用名額的選課（未退選、未被拒） */
  seatsUsed: number;
  /** 待審核 */
  pending: number;
}

/** 學員加入的結果：已加入、送出申請，或本來就在課程裡 */
export interface JoinResultDto {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  status: EnrollmentStatus;
  alreadyEnrolled: boolean;
}

/** GET /me/catalog：目前組織中公開的課程 */
export interface CatalogCourseDto {
  id: string;
  code: string;
  title: string;
  description: string | null;
  requireApproval: boolean;
  /** 我在這門課的選課（未退選、未被拒）；沒有則 null */
  myEnrollment: { id: string; status: EnrollmentStatus } | null;
  /** 現在能不能加入：open／not_yet／closed／full */
  availability: 'open' | 'not_yet' | 'closed' | 'full';
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

/** 通知（SA UC-AUD-003／004、SD §6.26）：站內通知與 Email 通知 */

export const NOTIFICATION_TYPES = [
  'enrollment.assigned',
  'enrollment.approved',
  'enrollment.rejected',
  'enrollment.requested',
  'enrollment.reopened',
  'relearning.assigned',
  'certificate.issued',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const isNotificationType = (t: string): t is NotificationType => (NOTIFICATION_TYPES as readonly string[]).includes(t);

/**
 * 通知內容：只放顯示與連結需要的欄位——不含成績、作答等學習細節（MOD-NOTIF 護欄）。
 * 重修原因只出現在站內通知（信件只說有新的重修，請登入查看）。
 */
export interface NotificationPayload {
  organizationName?: string;
  courseId?: string;
  courseTitle?: string;
  enrollmentId?: string;
  /** enrollment.requested：申請人（給審核者） */
  learnerName?: string;
  /** relearning.assigned */
  scopeType?: string;
  scopeTitle?: string | null;
  reason?: string;
  /** certificate.issued */
  certificateId?: string;
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  organizationId: string | null;
  payload: NotificationPayload;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPreferenceDto {
  type: NotificationType;
  inApp: boolean;
  email: boolean;
}

/** Email 通知由 worker 寄出（SD §11.1）；idempotency key 以通知 id 保證一則通知只排一次 */
export const NOTIFICATION_EMAIL_JOB = { type: 'notification.email', queue: 'output', priority: 80, maxAttempts: 5 } as const;
export const notificationJobKey = (notificationId: string): string => `mail:${notificationId}`;

/** 通知的連結（站內與信件共用；相對於網站根目錄） */
export function notificationLink(type: NotificationType, p: NotificationPayload): string {
  const seg = (v: string | undefined) => (v ? encodeURIComponent(v) : '');
  switch (type) {
    case 'enrollment.requested':
      return p.courseId ? `/app/courses/${seg(p.courseId)}` : '/app/courses';
    case 'enrollment.rejected':
      return '/app/learn';
    case 'certificate.issued':
      return p.certificateId ? `/app/certificates/${seg(p.certificateId)}` : '/app/certificates';
    default:
      return p.enrollmentId ? `/app/learn/${seg(p.enrollmentId)}` : '/app/learn';
  }
}

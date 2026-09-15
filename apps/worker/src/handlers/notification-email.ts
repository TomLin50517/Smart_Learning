import { isNotificationType, NOTIFICATION_EMAIL_JOB, type NotificationPayload } from '@iac/contracts';
import { pickLanguage, renderNotificationMail } from '@iac/domain';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { Job, JobHandler } from '../dispatcher.js';
import type { WorkerMailer } from '../mailer.js';
import { FatalError } from '../retry-policy.js';

/**
 * 寄出 Email 通知（SD §6.26、§11.1 notification.email）。
 * 冪等：notifications.sent_at 非 NULL 即跳過（SD §11.4）；寄出後才寫 sent_at——寄出與寫入之間當機會重寄一次（至少一次）。
 * 帳號停用的收件者不寄。未設定 SMTP 時只記 log、不寫 sent_at（之後設定也不會補寄舊通知——job 已完成）。
 * Log 只記通知類型、收件者網域與 message id；失敗只記 SMTP 錯誤碼與回應碼（同 §8.10）。
 */
export class NotificationEmailHandler implements JobHandler {
  readonly jobType = NOTIFICATION_EMAIL_JOB.type;
  readonly timeoutMs = 60_000;

  constructor(
    private readonly db: pg.Pool,
    private readonly mailer: WorkerMailer | null,
    private readonly log: Logger,
    private readonly baseUrl: string,
  ) {}

  async handle(job: Job): Promise<void> {
    const id = job.payload['notificationId'];
    if (typeof id !== 'string') throw new FatalError('notification.email: payload.notificationId is missing');
    const r = await this.db.query<{ type: string; payload: NotificationPayload; sent_at: Date | null; email: string; locale: string; user_status: string }>(
      `SELECT n.type, n.payload, n.sent_at, u.email::text AS email, u.locale, u.status::text AS user_status
         FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.id = $1 AND n.channel = 'email'`,
      [id],
    );
    const n = r.rows[0];
    if (!n) throw new FatalError(`notification.email: notification ${id} not found`);
    if (n.sent_at) return;
    if (!isNotificationType(n.type)) throw new FatalError(`notification.email: unknown notification type ${n.type}`);
    const log = this.log.child({ kind: n.type, notification_id: id, recipient_domain: n.email.split('@')[1] });
    if (n.user_status !== 'active') {
      log.info('recipient account is not active — notification email skipped');
      return;
    }
    if (!this.mailer) {
      log.info('SMTP is not configured — notification email not sent');
      return;
    }
    const mail = renderNotificationMail(n.type, n.payload, pickLanguage(n.locale), this.baseUrl);
    try {
      const messageId = await this.mailer.send(n.email, mail);
      log.info({ message_id: messageId }, 'notification email sent');
    } catch (err) {
      const e = err as { code?: unknown; responseCode?: unknown };
      log.error({ smtp_error: e.code, smtp_response_code: e.responseCode }, 'notification email could not be sent');
      throw new Error('notification email was not accepted by the mail server');
    }
    await this.db.query(`UPDATE notifications SET sent_at = now() WHERE id = $1 AND sent_at IS NULL`, [id]);
  }
}

import { Module } from '@nestjs/common';
import { logger } from '../../common/logger.js';
import { ENV, type Env } from '../../config/env.js';
import { NotificationController } from './api/notification.controller.js';
import { NotificationService } from './application/notification.service.js';
import { LogOnlyMailer } from './infrastructure/log-only.mailer.js';
import { SmtpMailer } from './infrastructure/smtp.mailer.js';
import { ACCOUNT_MAILER, NOTIFIER, type AccountMailer } from './notification.contracts.js';

/**
 * MOD-NOTIF：in-app + email、模板、偏好
 * 護欄：通知不含敏感學習細節
 *
 * 已實作：帳號信件（密碼重設、組織邀請）的 SMTP 寄送（SD §8.10）；
 * 事件通知（站內通知、Email 經 worker 寄出、偏好設定；SD §6.26）。
 */
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationService,
    { provide: NOTIFIER, useExisting: NotificationService },
    {
      provide: ACCOUNT_MAILER,
      inject: [ENV],
      useFactory: (env: Env): AccountMailer => {
        if (env.SMTP_HOST) return new SmtpMailer(env);
        if (env.NODE_ENV === 'production') {
          logger.warn('SMTP_HOST is not set — password reset and invitation emails will NOT be sent');
        }
        return new LogOnlyMailer(env);
      },
    },
  ],
  exports: [ACCOUNT_MAILER, NOTIFIER],
})
export class NotificationModule {}

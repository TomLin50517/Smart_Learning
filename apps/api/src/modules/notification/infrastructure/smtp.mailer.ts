import type { OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Mail, type SMTPSentMessageInfo } from 'nodemailer';
import { logger } from '../../../common/logger.js';
import type { Env } from '../../../config/env.js';
import { pickLanguage, renderInvitation, renderPasswordReset, type RenderedMail } from '../application/account-templates.js';
import type { AccountLinkMail, AccountMailer } from '../notification.contracts.js';

/**
 * SMTP 寄送帳號信件（SD §8.10）。
 *
 * - TLS：SMTP_SECURE=true 為隱式 TLS（465）；否則預設 requireTLS——伺服器不支援 STARTTLS 就拒絕寄出，
 *   而不是降級成明文（信件含一次性 token）。憑證一律驗證；內部 CA 以 NODE_EXTRA_CA_CERTS 提供。
 * - log 只記收件者網域與 message id，不記連結、不記完整錯誤物件（可能夾帶伺服器回應）。
 */
export class SmtpMailer implements AccountMailer, OnModuleDestroy {
  private readonly transport: Mail<SMTPSentMessageInfo>;

  constructor(private readonly env: Env) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE && env.SMTP_REQUIRE_TLS,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
      // 同步寄送位於請求路徑上：寧可快速失敗，也不讓請求卡住數分鐘（nodemailer 預設 2～10 分鐘）
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  sendPasswordReset(m: AccountLinkMail): Promise<void> {
    return this.send('password_reset', m.to, renderPasswordReset(pickLanguage(m.locale), m));
  }

  sendInvitation(m: AccountLinkMail & { organizationName: string }): Promise<void> {
    return this.send('invitation', m.to, renderInvitation(pickLanguage(m.locale), m));
  }

  onModuleDestroy(): void {
    this.transport.close();
  }

  private async send(kind: string, to: string, mail: RenderedMail): Promise<void> {
    const recipient_domain = to.split('@')[1];
    try {
      const info = await this.transport.sendMail({
        from: this.env.SMTP_FROM,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // RFC 3834：標示為自動信件，避免自動回覆程式回信
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      logger.info({ kind, recipient_domain, message_id: info.messageId }, 'account email sent');
    } catch (err) {
      const e = err as { code?: unknown; responseCode?: unknown };
      logger.error({ kind, recipient_domain, smtp_error: e.code, smtp_response_code: e.responseCode }, 'account email could not be sent');
      throw new Error(`account email (${kind}) was not accepted by the mail server`);
    }
  }
}

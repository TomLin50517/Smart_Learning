import { logger } from '../../../common/logger.js';
import type { Env } from '../../../config/env.js';
import type { AccountLinkMail, AccountMailer } from '../notification.contracts.js';

/**
 * 未設定 SMTP_HOST 時的實作。
 * - 非正式環境：把連結寫進 log，方便開發測試（明確標示）
 * - 正式環境：只記錄「未寄出」，**絕不**把 token 寫進 log
 */
export class LogOnlyMailer implements AccountMailer {
  constructor(private readonly env: Env) {}

  sendPasswordReset(m: AccountLinkMail): Promise<void> {
    return this.log('password_reset', m.to, m.link);
  }

  sendInvitation(m: AccountLinkMail & { organizationName: string }): Promise<void> {
    return this.log('invitation', m.to, m.link);
  }

  private async log(kind: string, to: string, link: string): Promise<void> {
    if (this.env.NODE_ENV === 'production') {
      logger.error({ kind, recipient_domain: to.split('@')[1] }, 'account email requested but SMTP is not configured — email NOT sent');
      return;
    }
    logger.warn({ kind, to, link }, '[non-production] account email link (SMTP not configured)');
  }
}

/**
 * MOD-NOTIF 對外介面。其他模組只能 import 此檔或 notification.module.ts（SD §1.2、.dependency-cruiser.cjs）。
 */

export interface MailRecipient {
  to: string;
  /** 依收件者語系選擇信件內容（en* → 英文，其餘 → 繁體中文） */
  locale: string;
}

/** 含一次性 token 連結的帳號信件 */
export interface AccountLinkMail extends MailRecipient {
  link: string;
  /** 連結有效期，寫進信件內容讓收件者知道期限 */
  expiresInMinutes: number;
}

/**
 * 帳號相關信件（密碼重設、組織邀請），SD §8.10。
 * - 屬安全性信件：同步直接寄出，不經 job queue（token 不落地到佇列資料表）
 * - 實作絕不把連結寫進 log（正式環境）
 * - 寄送失敗時 reject，由呼叫端決定如何處理
 */
export interface AccountMailer {
  sendPasswordReset(m: AccountLinkMail): Promise<void>;
  sendInvitation(m: AccountLinkMail & { organizationName: string }): Promise<void>;
}

export const ACCOUNT_MAILER = Symbol('ACCOUNT_MAILER');

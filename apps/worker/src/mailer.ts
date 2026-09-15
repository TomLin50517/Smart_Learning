import type { RenderedMail } from '@iac/domain';
import nodemailer from 'nodemailer';

export interface MailEnv {
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_REQUIRE_TLS: boolean;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  SMTP_FROM: string;
}

export interface WorkerMailer {
  /** 寄出並回傳 message id；失敗時 reject（錯誤物件可能夾帶伺服器回應，呼叫端不可整個寫進 log） */
  send(to: string, mail: RenderedMail): Promise<string>;
  close(): void;
}

/**
 * 通知信的 SMTP 寄送（SD §6.26）。TLS 規則與 API 的帳號信件相同（§8.10）：SMTP_SECURE=true 為隱式 TLS；
 * 否則預設 requireTLS——不降級為明文；憑證一律驗證。未設定 SMTP_HOST 時回傳 null（信件不寄，只記 log）。
 */
export function createWorkerMailer(env: MailEnv): WorkerMailer | null {
  if (!env.SMTP_HOST) return null;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE && env.SMTP_REQUIRE_TLS,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return {
    async send(to, mail) {
      const info = await transport.sendMail({
        from: env.SMTP_FROM,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // RFC 3834：標示為自動信件，避免自動回覆程式回信
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      return String(info.messageId);
    },
    close() {
      transport.close();
    },
  };
}

/**
 * 帳號信件模板（SD §8.10）。純函式，不含 I/O，方便單元測試。
 * 護欄：通知不含敏感學習細節——帳號信件只有連結與期限。
 */

export type MailLanguage = 'zh-TW' | 'en';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** 使用者語系 → 信件語言。未知語系一律回繁體中文（系統預設 locale） */
export function pickLanguage(locale: string): MailLanguage {
  return locale.trim().toLowerCase().startsWith('en') ? 'en' : 'zh-TW';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * 放進主旨等單行位置的外部字串（組織名稱）：移除控制字元（含 CR/LF，防 header 注入）並限制長度。
 * nodemailer 本身也會編碼 header，這裡是第二道防線。
 */
export function oneLine(s: string, max = 120): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatDuration(minutes: number, lang: MailLanguage): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return lang === 'en' ? `${h} hour${h === 1 ? '' : 's'}` : `${h} 小時`;
  }
  return lang === 'en' ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${minutes} 分鐘`;
}

const FOOTER: Record<MailLanguage, string> = {
  'zh-TW': '此為系統自動發送的信件，請勿直接回覆。',
  en: 'This is an automated message. Please do not reply.',
};

/** 純文字段落 + 連結 → 同內容的 HTML（所有外部字串皆經跳脫） */
function layout(lang: MailLanguage, before: string[], action: { label: string; link: string }, after: string[]): string {
  const p = (t: string) => `<p style="margin:0 0 16px">${escapeHtml(t)}</p>`;
  const href = escapeHtml(action.link);
  return [
    `<!doctype html><html lang="${lang}"><body style="margin:0;padding:24px;background:#f5f5f4;font-family:system-ui,-apple-system,'Segoe UI','Noto Sans TC',sans-serif;color:#1c1917;line-height:1.6">`,
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">',
    ...before.map(p),
    `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#57534e;word-break:break-all">${escapeHtml(lang === 'en' ? 'If the button does not work, copy this link into your browser:' : '若按鈕無法開啟，請將以下連結複製到瀏覽器：')}<br><a href="${href}" style="color:#1d4ed8">${href}</a></p>`,
    ...after.map(p),
    `<p style="margin:24px 0 0;font-size:12px;color:#78716c">${escapeHtml(FOOTER[lang])}</p>`,
    '</div></body></html>',
  ].join('');
}

function text(lang: MailLanguage, before: string[], link: string, after: string[]): string {
  return [...before, link, ...after, `— ${FOOTER[lang]}`].join('\n\n') + '\n';
}

export function renderPasswordReset(lang: MailLanguage, m: { link: string; expiresInMinutes: number }): RenderedMail {
  const ttl = formatDuration(m.expiresInMinutes, lang);
  if (lang === 'en') {
    const before = ['Hello,', `We received a request to reset the password for your account. Open the link below within ${ttl} to choose a new password:`];
    const after = ['The link can be used only once. If you did not request this, you can ignore this email — your password will not change.'];
    return {
      subject: 'Reset your password',
      text: text(lang, before, m.link, after),
      html: layout(lang, before, { label: 'Reset password', link: m.link }, after),
    };
  }
  const before = ['您好：', `我們收到重設您帳號密碼的要求。請在 ${ttl} 內開啟以下連結設定新密碼：`];
  const after = ['此連結只能使用一次。如果這不是您本人的要求，請忽略此信，您的密碼不會變更。'];
  return {
    subject: '重設您的密碼',
    text: text(lang, before, m.link, after),
    html: layout(lang, before, { label: '重設密碼', link: m.link }, after),
  };
}

export function renderInvitation(
  lang: MailLanguage,
  m: { link: string; expiresInMinutes: number; organizationName: string },
): RenderedMail {
  const ttl = formatDuration(m.expiresInMinutes, lang);
  const org = oneLine(m.organizationName);
  if (lang === 'en') {
    const before = ['Hello,', `You have been added to "${org}" on the learning platform. Open the link below within ${ttl} to set your password:`];
    const after = ['If the link has expired, use "Forgot password" on the sign-in page to get a new one.'];
    return {
      subject: `You're invited to join ${org}`,
      text: text(lang, before, m.link, after),
      html: layout(lang, before, { label: 'Set password', link: m.link }, after),
    };
  }
  const before = ['您好：', `您已被加入「${org}」的學習平台。請在 ${ttl} 內開啟以下連結設定您的密碼：`];
  const after = ['連結逾期後，可在登入頁使用「忘記密碼」重新取得設定連結。'];
  return {
    subject: `您受邀加入「${org}」`,
    text: text(lang, before, m.link, after),
    html: layout(lang, before, { label: '設定密碼', link: m.link }, after),
  };
}

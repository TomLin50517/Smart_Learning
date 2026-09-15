/**
 * 通知信模板（SD §6.26）。純函式，不含 I/O。與帳號信件（API §8.10）相同的版面與防護：
 * 外部字串在 HTML 中跳脫；放進主旨前移除控制字元（含 CR/LF，防 header 注入）並限長。
 * 護欄：信件只含課程名稱與連結，不含成績等學習細節；重修原因不寫進信件（只在站內通知）。
 */
import { notificationLink, type NotificationPayload, type NotificationType } from '@iac/contracts';

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

/** 單行位置（主旨、段落中的名稱）：移除控制字元並限制長度 */
export function oneLine(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex -- 目的就是移除控制字元
  const flat = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const FOOTER: Record<MailLanguage, string> = {
  'zh-TW': '此為系統自動發送的信件，請勿直接回覆。',
  en: 'This is an automated message. Please do not reply.',
};

const SCOPE: Record<MailLanguage, Record<string, string>> = {
  'zh-TW': { module: '單元', lesson: '課節', activity: '活動' },
  en: { module: 'module', lesson: 'lesson', activity: 'activity' },
};

interface Copy {
  subject: string;
  lines: string[];
  action: string;
}

function copyFor(type: NotificationType, p: NotificationPayload, lang: MailLanguage): Copy {
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? oneLine(v) : fallback);
  const org = str(p.organizationName, '');
  if (lang === 'en') {
    const course = `"${str(p.courseTitle, 'your course')}"`;
    const at = org ? ` at ${org}` : '';
    const scope = p.scopeType && p.scopeType !== 'course' ? `the ${SCOPE.en[p.scopeType] ?? p.scopeType} "${str(p.scopeTitle, '')}"` : 'the whole course';
    switch (type) {
      case 'enrollment.assigned':
        return { subject: `You have been added to ${course}`, lines: [`You have been added to the course ${course}${at}. You can start learning now.`], action: 'Start learning' };
      case 'enrollment.approved':
        return { subject: `Your request to join ${course} was approved`, lines: [`Your request to join the course ${course}${at} was approved. You can start learning now.`], action: 'Start learning' };
      case 'enrollment.rejected':
        return { subject: `Your request to join ${course} was not approved`, lines: [`Your request to join the course ${course}${at} was not approved. Please contact the course staff if you have questions.`], action: 'My courses' };
      case 'enrollment.requested': {
        const who = str(p.learnerName, 'A learner');
        return { subject: `${who} asked to join ${course}`, lines: [`${who} asked to join the course ${course}${at} and is waiting for approval.`], action: 'Review requests' };
      }
      case 'enrollment.reopened':
        return { subject: `${course} has been reopened`, lines: [`Your teacher reopened ${course}. You can keep practising.`], action: 'Open the course' };
      case 'relearning.assigned':
        return { subject: `New relearning in ${course}`, lines: [`Your teacher assigned relearning for ${scope} in ${course}. Please sign in to see why and complete it again.`], action: 'Open the course' };
      case 'certificate.issued':
        return { subject: `Congratulations on completing ${course}`, lines: [`You completed the course ${course}${at}. Your certificate has been issued.`], action: 'View certificate' };
    }
  }
  const course = `「${str(p.courseTitle, '課程')}」`;
  const at = org ? `「${org}」的` : '';
  const scope = p.scopeType && p.scopeType !== 'course' ? `${SCOPE['zh-TW'][p.scopeType] ?? p.scopeType}「${str(p.scopeTitle, '')}」` : '整門課';
  switch (type) {
    case 'enrollment.assigned':
      return { subject: `你已加入課程${course}`, lines: [`你已被加入${at}課程${course}，現在就可以開始學習。`], action: '開始學習' };
    case 'enrollment.approved':
      return { subject: `加入${course}的申請已通過`, lines: [`你申請加入${at}課程${course}已通過審核，現在就可以開始學習。`], action: '開始學習' };
    case 'enrollment.rejected':
      return { subject: `加入${course}的申請未通過`, lines: [`你申請加入${at}課程${course}未通過審核。如有疑問，請聯絡課程老師。`], action: '查看我的課程' };
    case 'enrollment.requested': {
      const who = str(p.learnerName, '一位學員');
      return { subject: `${who} 申請加入${course}`, lines: [`${who} 申請加入${at}課程${course}，正在等待審核。`], action: '前往審核' };
    }
    case 'enrollment.reopened':
      return { subject: `${course}已重新開啟`, lines: [`老師已重新開啟${course}，你可以繼續練習。`], action: '進入課程' };
    case 'relearning.assigned':
      return { subject: `${course}有新的重修`, lines: [`老師指派了${course}的重修（${scope}），請登入查看原因並重新完成指定的內容。`], action: '進入課程' };
    case 'certificate.issued':
      return { subject: `恭喜完成${course}`, lines: [`你已完成${at}課程${course}，結業證書已發出。`], action: '查看證書' };
  }
}

function layout(lang: MailLanguage, before: string[], action: { label: string; link: string }, after: string[]): string {
  const p = (t: string) => `<p style="margin:0 0 16px">${escapeHtml(t)}</p>`;
  const href = escapeHtml(action.link);
  return [
    `<!doctype html><html lang="${lang}"><body style="margin:0;padding:24px;background:#f5f5f4;font-family:system-ui,-apple-system,'Segoe UI','Noto Sans TC',sans-serif;color:#1c1917;line-height:1.6">`,
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">',
    ...before.map(p),
    `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>`,
    ...after.map((t) => `<p style="margin:0 0 16px;font-size:13px;color:#57534e;word-break:break-all">${escapeHtml(t)}</p>`),
    `<p style="margin:24px 0 0;font-size:12px;color:#78716c">${escapeHtml(FOOTER[lang])}</p>`,
    '</div></body></html>',
  ].join('');
}

/** 通知信：主旨、純文字、HTML。baseUrl 為網站的公開網址（PUBLIC_BASE_URL） */
export function renderNotificationMail(type: NotificationType, p: NotificationPayload, lang: MailLanguage, baseUrl: string): RenderedMail {
  const c = copyFor(type, p, lang);
  const base = baseUrl.replace(/\/+$/, '');
  const link = `${base}${notificationLink(type, p)}`;
  const settings = `${base}/app/notifications`;
  const before = [lang === 'en' ? 'Hello,' : '您好：', ...c.lines];
  const after = [lang === 'en' ? `To choose which emails you receive, open notification settings: ${settings}` : `如不想收到這類信件，可以到通知設定關閉：${settings}`];
  const actionLine = lang === 'en' ? `${c.action}: ${link}` : `${c.action}：${link}`;
  return {
    subject: oneLine(c.subject, 160),
    text: [...before, actionLine, ...after, `— ${FOOTER[lang]}`].join('\n\n') + '\n',
    html: layout(lang, before, { label: c.action, link }, after),
  };
}

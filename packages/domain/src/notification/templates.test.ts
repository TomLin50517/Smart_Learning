import { NOTIFICATION_TYPES } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { pickLanguage, renderNotificationMail } from './templates.js';

const BASE = 'https://learn.example.com/';
const P = { organizationName: '示範大學', courseId: 'c-1', courseTitle: '資料結構', enrollmentId: 'e-1', certificateId: 'cert-1', learnerName: '王小明' };

describe('renderNotificationMail', () => {
  it('every type renders in both languages with a link back to the right page', () => {
    for (const t of NOTIFICATION_TYPES) {
      for (const lang of ['zh-TW', 'en'] as const) {
        const m = renderNotificationMail(t, P, lang, BASE);
        expect(m.subject.length).toBeGreaterThan(0);
        expect(m.text).toContain('https://learn.example.com/app/');
        expect(m.html).toContain('https://learn.example.com/app/notifications');
      }
    }
    expect(renderNotificationMail('enrollment.assigned', P, 'zh-TW', BASE).text).toContain('https://learn.example.com/app/learn/e-1');
    expect(renderNotificationMail('enrollment.requested', P, 'zh-TW', BASE).text).toContain('/app/courses/c-1');
    expect(renderNotificationMail('certificate.issued', P, 'en', BASE).text).toContain('/app/certificates/cert-1');
  });

  it('says who and what in the reader’s language', () => {
    expect(renderNotificationMail('enrollment.assigned', P, 'zh-TW', BASE).subject).toBe('你已加入課程「資料結構」');
    expect(renderNotificationMail('enrollment.requested', P, 'zh-TW', BASE).subject).toBe('王小明 申請加入「資料結構」');
    expect(renderNotificationMail('enrollment.approved', P, 'en', BASE).subject).toBe('Your request to join "資料結構" was approved');
    expect(pickLanguage('en-US')).toBe('en');
    expect(pickLanguage('zh-TW')).toBe('zh-TW');
  });

  it('never puts the relearning reason into the email', () => {
    const m = renderNotificationMail('relearning.assigned', { ...P, scopeType: 'module', scopeTitle: '第一單元', reason: '上次考太差' }, 'zh-TW', BASE);
    expect(m.text).toContain('單元「第一單元」');
    expect(m.text).not.toContain('上次考太差');
    expect(m.html).not.toContain('上次考太差');
  });

  it('escapes HTML and strips header-breaking characters from outside strings', () => {
    const m = renderNotificationMail('enrollment.assigned', { ...P, courseTitle: '<script>alert(1)</script>\r\nBcc: x@evil.test' }, 'zh-TW', BASE);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});

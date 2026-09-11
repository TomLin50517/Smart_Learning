import { describe, expect, it } from 'vitest';
import { escapeHtml, formatDuration, oneLine, pickLanguage, renderInvitation, renderPasswordReset } from './account-templates.js';

const LINK = 'https://learn.example.test/password-reset?token=abc_DEF-123';

describe('pickLanguage', () => {
  it('en* → English, everything else → Traditional Chinese (system default)', () => {
    for (const l of ['en', 'en-US', 'EN_gb']) expect(pickLanguage(l)).toBe('en');
    for (const l of ['zh-TW', 'zh', 'ja', '']) expect(pickLanguage(l)).toBe('zh-TW');
  });
});

describe('formatDuration', () => {
  it('whole hours are shown as hours, otherwise minutes', () => {
    expect(formatDuration(30, 'zh-TW')).toBe('30 分鐘');
    expect(formatDuration(4320, 'zh-TW')).toBe('72 小時');
    expect(formatDuration(60, 'en')).toBe('1 hour');
    expect(formatDuration(4320, 'en')).toBe('72 hours');
    expect(formatDuration(1, 'en')).toBe('1 minute');
    expect(formatDuration(90, 'en')).toBe('90 minutes');
  });
});

describe('oneLine — values placed in the subject header', () => {
  it('strips CR/LF and other control characters (header injection)', () => {
    expect(oneLine('Org A\r\nBcc: evil@x.test')).toBe('Org A Bcc: evil@x.test');
    expect(oneLine('\u0007Org\tB\u0000')).toBe('Org B');
  });

  it('limits the length', () => {
    const s = oneLine('x'.repeat(500));
    expect(s).toHaveLength(120);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderPasswordReset', () => {
  it('zh-TW: subject, link and validity period', () => {
    const m = renderPasswordReset('zh-TW', { link: LINK, expiresInMinutes: 30 });
    expect(m.subject).toBe('重設您的密碼');
    expect(m.text).toContain(LINK);
    expect(m.text).toContain('30 分鐘');
    expect(m.html).toContain(`href="${LINK}"`);
    expect(m.html).toContain('lang="zh-TW"');
  });

  it('en: English subject and body', () => {
    const m = renderPasswordReset('en', { link: LINK, expiresInMinutes: 30 });
    expect(m.subject).toBe('Reset your password');
    expect(m.text).toContain('within 30 minutes');
    expect(m.text).toContain(LINK);
  });

  it('the link is attribute-escaped in HTML but verbatim in plain text', () => {
    const link = 'https://learn.example.test/p?a=1&token=t';
    const m = renderPasswordReset('en', { link, expiresInMinutes: 30 });
    expect(m.html).toContain('href="https://learn.example.test/p?a=1&amp;token=t"');
    expect(m.html).not.toContain('a=1&token');
    expect(m.text).toContain(link);
  });
});

describe('renderInvitation', () => {
  const hostile = '<script>alert(1)</script> & Co\r\nBcc: evil@x.test';

  it('organization name cannot inject HTML or headers', () => {
    const m = renderInvitation('zh-TW', { link: LINK, expiresInMinutes: 4320, organizationName: hostile });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe('您受邀加入「<script>alert(1)</script> & Co Bcc: evil@x.test」');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(m.text).toContain('72 小時');
    expect(m.text).toContain(LINK);
  });

  it('en: points to "Forgot password" for expired links', () => {
    const m = renderInvitation('en', { link: LINK, expiresInMinutes: 4320, organizationName: 'Org A' });
    expect(m.subject).toBe("You're invited to join Org A");
    expect(m.text).toContain('within 72 hours');
    expect(m.text).toContain('Forgot password');
  });
});

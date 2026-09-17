import { CMS_LIMITS } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { CmsDraftInput, CmsRollbackInput } from './cms-inputs.js';

const ID = '11111111-2222-3333-4444-555555555555';
const ok = (blocks: unknown[]) => CmsDraftInput.safeParse({ blocks });

describe('CmsDraftInput — 接受合法的區塊', () => {
  it('accepts every supported block type', () => {
    const r = ok([
      { type: 'hero', title: '歡迎', subtitle: '副標', cta: { label: '開始', href: 'https://example.com/start' }, imageAssetId: ID },
      { type: 'richtext', markdown: '# 標題\n\n內文' },
      { type: 'image', assetId: ID, alt: '說明文字', caption: '圖說' },
      { type: 'video', assetId: ID, poster: ID },
      { type: 'announcement', items: [{ title: '公告', body: '內容', publishedAt: '2026-09-17T00:00:00.000Z' }] },
      { type: 'callout', variant: 'info', body: '提示' },
      { type: 'footer', links: [{ label: '隱私權', href: 'https://example.com/privacy' }] },
    ]);
    expect(r.success).toBe(true);
  });

  it('accepts an empty page', () => {
    expect(ok([]).success).toBe(true);
  });
});

describe('CmsDraftInput — 擋下注入（ARCH §16.1）', () => {
  it('rejects raw html smuggled in as an extra field', () => {
    // strictObject 的用意就在這裡：多一個欄位就整筆拒絕
    expect(ok([{ type: 'richtext', markdown: '安全', html: '<script>alert(1)</script>' }]).success).toBe(false);
    expect(ok([{ type: 'callout', variant: 'info', body: 'x', onClick: 'alert(1)' }]).success).toBe(false);
  });

  it('rejects unknown block types', () => {
    expect(ok([{ type: 'script', src: 'https://evil.example/x.js' }]).success).toBe(false);
    expect(ok([{ type: 'activity', activityId: ID }]).success).toBe(false); // activity 只屬於課程單元
    expect(ok([{ type: 'course_list', filter: {}, limit: 5 }]).success).toBe(false); // 尚未支援
  });

  it('rejects non-http links everywhere they can appear', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox', 'file:///etc/passwd', 'not a url']) {
      expect(ok([{ type: 'footer', links: [{ label: 'x', href }] }]).success, href).toBe(false);
      expect(ok([{ type: 'hero', title: 't', cta: { label: 'x', href } }]).success, href).toBe(false);
    }
  });

  it('rejects external URLs where an assetId is required', () => {
    // 圖片與影片只能引用素材庫，避免 SSRF 與追蹤像素
    expect(ok([{ type: 'image', assetId: 'https://evil.example/pixel.gif', alt: 'x' }]).success).toBe(false);
    expect(ok([{ type: 'video', assetId: 'https://evil.example/v.mp4' }]).success).toBe(false);
  });

  it('requires alt text on images', () => {
    expect(ok([{ type: 'image', assetId: ID, alt: '' }]).success).toBe(false);
    expect(ok([{ type: 'image', assetId: ID }]).success).toBe(false);
  });
});

describe('CmsDraftInput — 上限', () => {
  it('caps the number of blocks and the payload size', () => {
    expect(ok(Array.from({ length: CMS_LIMITS.blocks + 1 }, () => ({ type: 'callout', variant: 'info', body: 'x' }))).success).toBe(false);
    expect(ok([{ type: 'richtext', markdown: 'x'.repeat(CMS_LIMITS.markdownChars + 1) }]).success).toBe(false);
    // 單一區塊合法，但整體 JSON 過大
    const big = Array.from({ length: 10 }, () => ({ type: 'richtext', markdown: 'x'.repeat(CMS_LIMITS.markdownChars) }));
    expect(ok(big).success).toBe(false);
  });

  it('caps announcement items and footer links', () => {
    const item = { title: 't', body: 'b', publishedAt: '2026-09-17T00:00:00.000Z' };
    expect(ok([{ type: 'announcement', items: Array.from({ length: CMS_LIMITS.announcementItems + 1 }, () => item) }]).success).toBe(false);
    expect(ok([{ type: 'footer', links: Array.from({ length: CMS_LIMITS.footerLinks + 1 }, () => ({ label: 'x', href: 'https://e.test' })) }]).success).toBe(false);
  });

  it('rejects a malformed publishedAt', () => {
    expect(ok([{ type: 'announcement', items: [{ title: 't', body: 'b', publishedAt: '2026-09-17' }] }]).success).toBe(false);
  });
});

describe('CmsRollbackInput', () => {
  it('only accepts a positive revision number', () => {
    expect(CmsRollbackInput.safeParse({ revisionNo: 3 }).success).toBe(true);
    expect(CmsRollbackInput.safeParse({ revisionNo: 0 }).success).toBe(false);
    expect(CmsRollbackInput.safeParse({ revisionNo: -1 }).success).toBe(false);
    expect(CmsRollbackInput.safeParse({ revisionNo: 1.5 }).success).toBe(false);
    expect(CmsRollbackInput.safeParse({ revisionNo: 1, extra: true }).success).toBe(false);
  });
});

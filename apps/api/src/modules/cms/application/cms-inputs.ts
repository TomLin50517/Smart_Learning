import { CMS_LIMITS } from '@iac/contracts';
import { z } from 'zod';

/**
 * 首頁 CMS 的輸入驗證（SD §7.5、ARCH §16.1）。比照課程內容的 course-inputs.ts：
 * `strictObject` + `discriminatedUnion`——**未知的 block type 與多餘欄位一律拒絕**，
 * 這正是擋下 raw HTML／script 注入的地方（例如 `{ type:'richtext', html:'<script>' }`）。
 */
const Id = z.guid();
const Text = z.string().trim().min(1).max(CMS_LIMITS.textChars);

/**
 * 連結只接受 http(s)。`javascript:`、`data:` 等必須在伺服器端就擋掉——
 * 只靠前端渲染時過濾，等於把安全押在每個渲染點都沒寫錯上。
 */
const HttpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => {
    try {
      return ['http:', 'https:'].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, 'href_must_be_http');

const Link = z.strictObject({ label: Text, href: HttpUrl });

export const PageBlockInput = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hero'),
    imageAssetId: Id.optional(),
    title: Text,
    subtitle: z.string().trim().max(CMS_LIMITS.textChars).optional(),
    cta: Link.optional(),
  }),
  z.strictObject({ type: z.literal('richtext'), markdown: z.string().max(CMS_LIMITS.markdownChars) }),
  z.strictObject({ type: z.literal('image'), assetId: Id, alt: z.string().trim().min(1).max(300), caption: z.string().max(500).optional() }),
  z.strictObject({ type: z.literal('video'), assetId: Id, poster: Id.optional() }),
  z.strictObject({
    type: z.literal('announcement'),
    items: z.array(z.strictObject({ title: Text, body: z.string().max(5000), publishedAt: z.iso.datetime() })).max(CMS_LIMITS.announcementItems),
  }),
  z.strictObject({ type: z.literal('callout'), variant: z.enum(['info', 'warning', 'success']), body: z.string().max(5000) }),
  z.strictObject({ type: z.literal('footer'), links: z.array(Link).max(CMS_LIMITS.footerLinks) }),
]);

export const CmsDraftInput = z
  .strictObject({ blocks: z.array(PageBlockInput).max(CMS_LIMITS.blocks) })
  .refine((v) => JSON.stringify(v.blocks).length <= CMS_LIMITS.jsonBytes, 'json_too_large');

export const CmsRollbackInput = z.strictObject({ revisionNo: z.number().int().positive() });

/**
 * 首頁 CMS（SA UC-CMS-001～005、§5.4；SD §7.5；ARCH §16.1）。
 *
 * 平台首頁與各組織首頁共用同一組 block 型別——`cms_pages.organization_id` 為 NULL 即平台首頁。
 * 沿用 migration 0009 的 `cms_pages` / `cms_revisions`，無新 migration。
 */

/** 頁面種類（cms_pages.page_key） */
export const CMS_PAGE_KEYS = ['home', 'about', 'footer'] as const;
export type CmsPageKey = (typeof CMS_PAGE_KEYS)[number];

export interface CmsCta {
  label: string;
  /** 只接受 http(s)；`javascript:` 之類在伺服器端就會被擋掉 */
  href: string;
}

/**
 * 首頁區塊（SD §7.5 的 CMS 子集）。`activity` 只用於課程單元，放進首頁會被拒絕。
 *
 * richtext 只存 Markdown，由前端以 allowlist 渲染；圖片與影片一律以 `assetId` 引用，
 * **不接受任意外部網址**——那會帶來 SSRF 與追蹤像素的風險（ARCH §16.1）。
 */
export type PageBlock =
  | { type: 'hero'; imageAssetId?: string; title: string; subtitle?: string; cta?: CmsCta }
  | { type: 'richtext'; markdown: string }
  | { type: 'image'; assetId: string; alt: string; caption?: string }
  | { type: 'video'; assetId: string; poster?: string }
  | { type: 'announcement'; items: { title: string; body: string; publishedAt: string }[] }
  | { type: 'callout'; variant: 'info' | 'warning' | 'success'; body: string }
  | { type: 'footer'; links: { label: string; href: string }[] };

export const PAGE_BLOCK_TYPES = ['hero', 'richtext', 'image', 'video', 'announcement', 'callout', 'footer'] as const;
export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

/** 草稿的上限（防止病態輸入拖垮驗證與寫入），比照 COURSE_LIMITS */
export const CMS_LIMITS = {
  blocks: 50,
  markdownChars: 20_000,
  textChars: 500,
  announcementItems: 20,
  footerLinks: 20,
  jsonBytes: 65_536,
} as const;

export interface CmsRevisionSummary {
  revisionNo: number;
  publishedAt: string;
  publishedByName: string | null;
}

/** GET /cms/pages/{pageKey}：編輯用——草稿、目前發布的內容與可回滾的版本 */
export interface CmsPageDto {
  pageKey: CmsPageKey;
  /** platform：平台首頁（只有平台管理員能編）；organization：目前組織的首頁 */
  scope: 'platform' | 'organization';
  draftBlocks: PageBlock[];
  publishedBlocks: PageBlock[] | null;
  publishedRevisionNo: number | null;
  publishedAt: string | null;
  /** 草稿與已發布的內容是否不同（前端據此提示「有未發布的變更」） */
  hasUnpublishedChanges: boolean;
  revisions: CmsRevisionSummary[];
  updatedAt: string | null;
}

/**
 * GET /public/cms/home：公開首頁（不需登入）。只回**已發布**的內容——
 * 草稿永遠不會出現在公開頁面。
 */
export interface PublicHomeDto {
  /** 組織首頁時為該組織代碼；平台首頁為 null */
  organizationCode: string | null;
  organizationName: string | null;
  blocks: PageBlock[];
  publishedAt: string | null;
}

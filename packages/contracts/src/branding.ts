/** 組織品牌（SD §6.16）：平台名稱、配色（八組預設或自訂主色）、Logo 與小圖示 */

export const DEFAULT_PLATFORM_NAME = '互動學習平台';
export const PLATFORM_NAME_MAX = 60;

export const BRAND_ASSET_KINDS = ['logo', 'icon'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];
/** 單張上限 512 KB */
export const BRAND_ASSET_MAX_BYTES = 524_288;
/** 只收點陣圖；SVG 可以夾帶程式碼，不收 */
export const BRAND_ASSET_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const THEME_KEYS = ['academy_blue', 'ocean', 'teal', 'forest', 'wine', 'violet', 'orange', 'graphite'] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];
export const DEFAULT_THEME: ThemeKey = 'academy_blue';

/** 八組預設配色：淺色模式的主色都與白字有 4.5 以上的對比度；深色模式另有較亮的版本 */
export const THEME_PRESETS: Record<ThemeKey, { label: string; light: string; dark: string }> = {
  academy_blue: { label: '學院藍', light: '#1d4ed8', dark: '#7c9bff' },
  ocean: { label: '深海藍', light: '#1e3a8a', dark: '#93b4ff' },
  teal: { label: '青綠', light: '#0f766e', dark: '#2dd4bf' },
  forest: { label: '森林綠', light: '#15803d', dark: '#4ade80' },
  wine: { label: '酒紅', light: '#9f1239', dark: '#fb7185' },
  violet: { label: '紫羅蘭', light: '#6d28d9', dark: '#a78bfa' },
  orange: { label: '暖橘', light: '#c2410c', dark: '#fb923c' },
  graphite: { label: '石墨灰', light: '#374151', dark: '#cbd5e1' },
};

/** 主色上放白字的最低對比度（WCAG AA，一般文字） */
export const MIN_BRAND_CONTRAST = 4.5;

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** 與白字的對比度（WCAG 2.x；1～21，取到小數兩位） */
export function contrastWithWhite(hex: string): number {
  return Math.round((1.05 / (luminance(hex) + 0.05)) * 100) / 100;
}

/** 深色模式用的主色：與白色混合 45%，在深色背景上夠亮 */
export function darkVariant(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45);
  return `#${[mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** 組織的品牌設定值（organizations.branding） */
export interface BrandingSettings {
  theme: ThemeKey;
  /** 自訂主色；有值時優先於預設配色 */
  customColor: string | null;
  /** 平台名稱；null＝使用平台預設名稱 */
  platformName: string | null;
}

/** 畫面上實際使用的品牌 */
export interface ResolvedBrandingDto {
  theme: ThemeKey | 'custom';
  colors: { light: string; dark: string };
  platformName: string;
  logoUrl: string | null;
  iconUrl: string | null;
}

/** GET /organizations/{id}/branding：設定頁用 */
export interface OrgBrandingDto extends ResolvedBrandingDto {
  organizationId: string;
  organizationCode: string;
  organizationName: string;
  settings: BrandingSettings;
}

/** GET /branding/{code}：組織登入畫面用（不需登入） */
export interface PublicBrandingDto extends ResolvedBrandingDto {
  organizationId: string;
  organizationCode: string;
  organizationName: string;
}

/** organizations.branding（jsonb）→ 設定值；不認得的值一律回預設 */
export function brandingSettings(raw: Record<string, unknown> | null | undefined): BrandingSettings {
  const t = raw?.['theme'];
  const c = raw?.['customColor'];
  const n = raw?.['platformName'];
  return {
    theme: typeof t === 'string' && (THEME_KEYS as readonly string[]).includes(t) ? (t as ThemeKey) : DEFAULT_THEME,
    customColor: isHexColor(c) ? c.toLowerCase() : null,
    platformName: typeof n === 'string' && n.trim() ? n.trim() : null,
  };
}

/** 素材網址：帶內容雜湊，換圖後瀏覽器快取自然失效 */
export const brandAssetUrl = (code: string, kind: BrandAssetKind, sha256: string): string => `/api/branding/${code}/${kind}?v=${sha256.slice(0, 12)}`;

/** 設定值＋素材 → 畫面用的品牌（API 與前端共用） */
export function resolveBranding(input: {
  code: string;
  branding: Record<string, unknown> | null | undefined;
  logoSha?: string | null | undefined;
  iconSha?: string | null | undefined;
}): ResolvedBrandingDto {
  const s = brandingSettings(input.branding);
  const preset = THEME_PRESETS[s.theme];
  return {
    theme: s.customColor ? 'custom' : s.theme,
    colors: s.customColor ? { light: s.customColor, dark: darkVariant(s.customColor) } : { light: preset.light, dark: preset.dark },
    platformName: s.platformName ?? DEFAULT_PLATFORM_NAME,
    logoUrl: input.logoSha ? brandAssetUrl(input.code, 'logo', input.logoSha) : null,
    iconUrl: input.iconSha ? brandAssetUrl(input.code, 'icon', input.iconSha) : null,
  };
}

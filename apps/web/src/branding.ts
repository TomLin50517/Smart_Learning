import type { ResolvedBrandingDto } from '@iac/contracts';
import type { CSSProperties } from 'react';

/**
 * 組織品牌在前端的套用（SD §6.16）：主色以 CSS 變數覆寫（淺色／深色各一），元素加上 data-brand 才生效。
 */
export function brandStyle(b: Pick<ResolvedBrandingDto, 'colors'> | null | undefined): CSSProperties | undefined {
  return b ? ({ '--org-brand': b.colors.light, '--org-brand-dark': b.colors.dark } as CSSProperties) : undefined;
}

const LAST_ORG = 'iac_login_org';
const ORG_CODE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** 記住最後使用的組織：登出或逾時後回到該組織的登入畫面（只存組織代碼） */
export function rememberLoginOrg(code: string | null): void {
  try {
    if (code) localStorage.setItem(LAST_ORG, code);
    else localStorage.removeItem(LAST_ORG);
  } catch {
    // 瀏覽器不允許儲存時就用一般登入頁
  }
}

/** 登入頁網址：記得組織時為 /o/{code}，否則 /login */
export function loginPath(): string {
  try {
    const c = localStorage.getItem(LAST_ORG);
    return c && ORG_CODE.test(c) ? `/o/${c}` : '/login';
  } catch {
    return '/login';
  }
}

/** 瀏覽器分頁的小圖示：組織有上傳就換成組織的 */
export function setFavicon(url: string | null): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = url ?? '/favicon.svg';
}

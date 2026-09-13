import { useEffect, useState } from 'react';

const BUNDLE = /<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/;
const INTERVAL_MS = 5 * 60_000;

/** index.html 內主程式的檔名（Vite 產物含內容雜湊，部署新版就會不同） */
export function bundleFromHtml(html: string): string | null {
  return BUNDLE.exec(html)?.[1] ?? null;
}

/**
 * 是否已部署新版本：單頁網站在重新整理前一直使用舊程式，部署後需提示使用者重新整理。
 * 每 5 分鐘、以及切回此分頁時比對伺服器上 index.html 的主程式檔名。開發模式（沒有 /assets/ 產物）不檢查。
 */
export function useNewVersionAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const current = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null;
    if (!current) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
        const latest = bundleFromHtml(await res.text());
        if (!stopped && latest && latest !== current) setAvailable(true);
      } catch {
        // 離線或伺服器重啟中：下次再檢查
      }
    };
    const onVisibility = () => void check();
    const timer = window.setInterval(onVisibility, INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return available;
}

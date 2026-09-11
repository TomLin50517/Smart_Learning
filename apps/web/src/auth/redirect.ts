/**
 * 登入後導回的 ?next= 參數只接受站內相對路徑，防止開放式重導向（登入頁被用來把使用者帶到釣魚站）。
 * 拒絕：絕對 URL、協定相對（//evil）、反斜線變形（/\evil，部分瀏覽器視同 //）、控制字元。
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  if (next.startsWith('/login')) return fallback;
  return next;
}

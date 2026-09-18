import type pg from 'pg';

/**
 * 限流是固定時間窗：視窗由資料庫時鐘對齊到整數倍的 windowSec（RateLimiter.hit 的
 * `floor(epoch / windowSec) * windowSec`）。一個情境裡連續幾次請求若剛好跨過視窗邊界，
 * 計數會被拆進兩個視窗，該擋的就沒擋到——測試因此偶爾失敗。
 *
 * 離目前視窗結束不到 marginSec 時，先等到新視窗開始再打。
 * 一輪請求實測約 0.25 秒，5 秒是給慢機器的餘裕；最壞情況多等 5 秒。
 */
export async function startOfFreshWindow(db: pg.Client, windowSec = 60, marginSec = 5): Promise<void> {
  const r = await db.query<{ left: string }>(
    `SELECT $1::numeric - mod(extract(epoch FROM clock_timestamp())::numeric, $1::numeric) AS left`,
    [windowSec],
  );
  const left = Number(r.rows[0]!.left);
  if (left < marginSec) await new Promise((res) => setTimeout(res, left * 1000 + 100));
}

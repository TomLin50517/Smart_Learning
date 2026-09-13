import { CLIENT_EVENT_TYPES, type ClientEventType } from '@iac/contracts';

/**
 * 學習時間、影片觀看比例與學員端事件檢查（SA §10.2–10.3、SD §6.12）。純函式，不碰 I/O。
 */

/** 相鄰事件相隔超過此秒數視為離開（不計入學習時間） */
export const IDLE_GAP_SEC = 300;
/** 可採計的最高播放倍速 */
export const MAX_PLAYBACK_RATE = 2;
/** 一個取樣間隔的寬限（video.progressed 每 15 秒送一次） */
const SAMPLE_SLACK_SEC = 15;

export interface TimePoint {
  /** epoch 毫秒 */
  at: number;
  activityId: string | null;
}

/**
 * 有效學習時間：相鄰事件的間隔加總；間隔超過 IDLE_GAP_SEC 視為離開，整段不計。
 * 學習畫面開著時每分鐘送一次 heartbeat，所以「持續在學」的間隔都在門檻內。
 * 間隔歸給前一個事件的活動（前一個沒有活動時歸給後一個）。
 */
export function learningSeconds(points: readonly TimePoint[], idleGapSec = IDLE_GAP_SEC): { total: number; byActivity: Record<string, number> } {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  let total = 0;
  const byActivity: Record<string, number> = {};
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const gap = (cur.at - prev.at) / 1000;
    if (gap <= 0 || gap > idleGapSec) continue;
    total += gap;
    const aid = prev.activityId ?? cur.activityId;
    if (aid) byActivity[aid] = (byActivity[aid] ?? 0) + gap;
  }
  return { total, byActivity };
}

export type Range = readonly [number, number];

/** 合併重疊的觀看區間（秒）；無效的區間（非數字、負值、結束不大於開始）略過 */
export function mergeRanges(ranges: readonly Range[]): [number, number][] {
  const valid = ranges
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s)
    .map(([s, e]) => [s, e] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

export interface VideoEvidence {
  at: number;
  durationSec?: number | undefined;
  ranges?: readonly Range[] | undefined;
}

/**
 * 以學習事件佐證的影片觀看比例：合併所有回報的觀看區間 ÷ 影片長度。
 * 防灌水：可採計的觀看秒數不超過「影片事件的實際學習時間 × 最高倍速 ＋ 一個取樣間隔」——
 * 一次送出「整部都看過」的區間不會被採信。影片長度以課程設定為準，沒有設定才用播放器回報的最大值。
 */
export function videoWatchRatio(events: readonly VideoEvidence[], configuredDurationSec?: number | null): number {
  if (!events.length) return 0;
  const reported = Math.max(0, ...events.map((e) => e.durationSec ?? 0));
  const duration = configuredDurationSec && configuredDurationSec > 0 ? configuredDurationSec : reported;
  if (!(duration > 0)) return 0;
  const merged = mergeRanges(events.flatMap((e) => (e.ranges ?? []).map(([s, x]) => [Math.max(0, s), Math.min(duration, x)] as const)));
  const watched = merged.reduce((n, [s, e]) => n + (e - s), 0);
  const elapsed = learningSeconds(events.map((e) => ({ at: e.at, activityId: null }))).total;
  const credible = Math.min(watched, elapsed * MAX_PLAYBACK_RATE + SAMPLE_SLACK_SEC);
  return Math.round(Math.min(1, credible / duration) * 10_000) / 10_000;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const MAX_DURATION_SEC = 86_400;
const MAX_RANGES = 200;
const MAX_PAYLOAD_BYTES = 4096;

/**
 * 學員端可送出的事件與 payload 檢查（SA §10.2）。回傳拒絕原因，合格回 null。
 * 其餘事件（提交、結果、完成、選課…）只由伺服器產生，學員端送來一律拒絕。
 */
export function checkClientEvent(type: string, payload: unknown): string | null {
  if (!(CLIENT_EVENT_TYPES as readonly string[]).includes(type)) return 'unknown_event_type';
  if (!isObj(payload)) return 'invalid_payload';
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) return 'payload_too_large';
  switch (type as ClientEventType) {
    case 'video.started':
      return isNum(payload.duration_sec, 0.1, MAX_DURATION_SEC) ? null : 'invalid_payload';
    case 'video.progressed': {
      const { position_sec: pos, duration_sec: dur, watched_ranges: ranges } = payload;
      if (!isNum(dur, 0.1, MAX_DURATION_SEC) || !isNum(pos, 0, dur + 1)) return 'invalid_payload';
      if (!Array.isArray(ranges) || ranges.length > MAX_RANGES) return 'invalid_payload';
      const ok = ranges.every((r) => Array.isArray(r) && r.length === 2 && isNum(r[0], 0, dur + 1) && isNum(r[1], 0, dur + 1) && r[1] > r[0]);
      return ok ? null : 'invalid_payload';
    }
    case 'activity.input_changed':
      return typeof payload.field === 'string' && payload.field.length <= 100 && (payload.summary === undefined || (typeof payload.summary === 'string' && payload.summary.length <= 500))
        ? null
        : 'invalid_payload';
    case 'activity.heartbeat':
      return null;
  }
}

import { EVENT_BATCH_MAX, HEARTBEAT_INTERVAL_SEC, VIDEO_SAMPLE_SEC, type LearningEventBatchResponse, type LearningEventInput } from '@iac/contracts';
import { useEffect, useMemo } from 'react';
import { api } from './api/client';
import { ApiError } from './api/errors';

/**
 * 學員端學習事件（SD §6.12–§6.13）：觀看區間追蹤、事件佇列、學習畫面的 heartbeat。
 * 事件只是學習紀錄——送不出去不影響作答：網路中斷時留著下次送，其餘錯誤（含 429 超過上限）直接丟棄。
 */

export type Range = [number, number];
const round1 = (n: number) => Math.round(n * 10) / 10;
/** 連續播放時相鄰兩次 timeupdate 的最大間隔（秒；2 倍速約 0.5 秒）；超過視為拖曳跳轉 */
const MAX_STEP_SEC = 2;
const MAX_RANGES = 200;
const MAX_QUEUE = 200;

/** 合併重疊的區間；無效區間略過 */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const valid = ranges
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s)
    .map(([s, e]) => [s, e] as Range)
    .sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** 觀看區間追蹤：只有連續播放才算看過；拖曳跳過的部分不算 */
export class WatchTracker {
  private ranges: Range[] = [];
  private last: number | null = null;

  /** 播放中每次 timeupdate 呼叫 */
  tick(pos: number): void {
    if (!Number.isFinite(pos)) return;
    if (this.last !== null && pos > this.last && pos - this.last <= MAX_STEP_SEC) {
      this.ranges.push([this.last, pos]);
      if (this.ranges.length > 64) this.ranges = mergeRanges(this.ranges);
    }
    this.last = pos;
  }

  /** 暫停或跳轉：下一次 tick 從新位置起算 */
  break(): void {
    this.last = null;
  }

  /** 已觀看的區間（秒，取到 0.1，裁在影片長度內） */
  watched(durationSec: number): Range[] {
    this.ranges = mergeRanges(this.ranges);
    return this.ranges
      .map(([s, e]) => [round1(Math.max(0, s)), round1(Math.min(durationSec, e))] as Range)
      .filter(([s, e]) => e > s)
      .slice(0, MAX_RANGES);
  }

  ratio(durationSec: number): number {
    if (!(durationSec > 0)) return 0;
    const sec = this.watched(durationSec).reduce((n, [s, e]) => n + (e - s), 0);
    return Math.min(1, sec / durationSec);
  }
}

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type EventSender = (attemptId: string, events: LearningEventInput[]) => Promise<unknown>;
const sendBatch: EventSender = (attemptId, events) => api<LearningEventBatchResponse>('POST', `/api/attempts/${attemptId}/events`, { events });

/** 一次作答的事件佇列：分批送出（每批最多 50 筆），同時間只有一個送出在進行 */
export class EventQueue {
  private queue: LearningEventInput[] = [];
  private inflight: Promise<void> | null = null;

  constructor(
    readonly attemptId: string,
    private readonly sender: EventSender = sendBatch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  push(eventType: string, payload: Record<string, unknown> = {}): void {
    this.queue.push({ eventId: uuid(), eventType, eventVersion: '1.0', occurredAt: this.clock().toISOString(), payload });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  get size(): number {
    return this.queue.length;
  }

  flush(): Promise<void> {
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, EVENT_BATCH_MAX);
      try {
        await this.sender(this.attemptId, batch);
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          // 網路中斷：放回佇列，下次再送（event_id 讓重送不會重複計算）
          this.queue.unshift(...batch);
          if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
          return;
        }
        // 429（超過每分鐘上限）、作答已結束等：丟棄，學習不受影響
      }
    }
  }
}

/**
 * 作答進行中的學習事件：學習畫面在前景時每 60 秒一筆 heartbeat（學習時間的依據），每 15 秒送出一次；
 * 切到背景、離開頁面、作答結束時立即送出。attemptId 為 null 時不做任何事。
 */
export function useLearningEvents(attemptId: string | null): EventQueue | null {
  const queue = useMemo(() => (attemptId ? new EventQueue(attemptId) : null), [attemptId]);
  useEffect(() => {
    if (!queue) return;
    const beat = () => {
      if (document.visibilityState === 'visible') queue.push('activity.heartbeat');
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void queue.flush();
      else beat();
    };
    beat();
    const hb = window.setInterval(beat, HEARTBEAT_INTERVAL_SEC * 1000);
    const fl = window.setInterval(() => void queue.flush(), VIDEO_SAMPLE_SEC * 1000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onVisibility);
    return () => {
      window.clearInterval(hb);
      window.clearInterval(fl);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onVisibility);
      void queue.flush();
    };
  }, [queue]);
  return queue;
}

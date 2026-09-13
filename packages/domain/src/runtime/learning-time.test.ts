import { describe, expect, it } from 'vitest';
import { checkClientEvent, learningSeconds, mergeRanges, videoWatchRatio } from './learning-time.js';

const t = (sec: number) => Date.UTC(2026, 8, 13, 8, 0, 0) + sec * 1000;

describe('learningSeconds', () => {
  it('sums gaps between events, skips breaks over 5 minutes, and credits the earlier activity', () => {
    const r = learningSeconds([
      { at: t(0), activityId: 'A' },
      { at: t(60), activityId: 'A' },
      { at: t(100), activityId: 'B' },
      { at: t(401), activityId: 'B' }, // 離開 301 秒：不計
      { at: t(431), activityId: null },
    ]);
    expect(r.total).toBe(130);
    expect(r.byActivity).toEqual({ A: 100, B: 30 });
  });

  it('does not depend on arrival order; events at the same instant add nothing', () => {
    const pts = [
      { at: t(30), activityId: 'A' },
      { at: t(0), activityId: 'A' },
      { at: t(30), activityId: 'A' },
    ];
    expect(learningSeconds(pts).total).toBe(30);
    expect(learningSeconds([]).total).toBe(0);
  });
});

describe('video watch ratio', () => {
  it('merges overlapping ranges and drops invalid ones', () => {
    expect(
      mergeRanges([
        [10, 20],
        [0, 5],
        [4, 8],
        [20, 25],
        [30, 30],
        [-1, 3],
      ]),
    ).toEqual([
      [0, 8],
      [10, 25],
    ]);
  });

  it('a video watched in real time counts in full', () => {
    const events = [{ at: t(0), durationSec: 100 }, ...Array.from({ length: 7 }, (_, i) => ({ at: t(15 * (i + 1)), durationSec: 100, ranges: [[0, Math.min(100, 15 * (i + 1))] as const] }))];
    expect(videoWatchRatio(events)).toBe(1);
    // 課程設定的影片長度優先於播放器回報
    expect(videoWatchRatio(events, 200)).toBe(0.5);
  });

  it('claiming the whole video in one go is not believed (capped by elapsed learning time)', () => {
    expect(videoWatchRatio([{ at: t(0), durationSec: 100, ranges: [[0, 100]] }])).toBe(0.15);
    expect(videoWatchRatio([])).toBe(0);
  });
});

describe('checkClientEvent', () => {
  it('accepts only learner-side events with well-formed payloads', () => {
    expect(checkClientEvent('activity.heartbeat', {})).toBeNull();
    expect(checkClientEvent('video.started', { duration_sec: 120 })).toBeNull();
    expect(checkClientEvent('video.progressed', { position_sec: 30, duration_sec: 120, watched_ranges: [[0, 30]] })).toBeNull();
    expect(checkClientEvent('activity.input_changed', { field: 'q1', summary: 'b' })).toBeNull();
  });

  it('rejects server-only events, bad payloads and oversized payloads', () => {
    expect(checkClientEvent('activity.submitted', {})).toBe('unknown_event_type');
    expect(checkClientEvent('course.completed', {})).toBe('unknown_event_type');
    expect(checkClientEvent('video.progressed', { position_sec: 30, duration_sec: 120, watched_ranges: [[40, 30]] })).toBe('invalid_payload');
    expect(checkClientEvent('video.progressed', { position_sec: 30, duration_sec: 120, watched_ranges: [[0, 500]] })).toBe('invalid_payload');
    expect(checkClientEvent('video.started', { duration_sec: -1 })).toBe('invalid_payload');
    expect(checkClientEvent('activity.heartbeat', [])).toBe('invalid_payload');
    expect(checkClientEvent('activity.input_changed', { field: 'x', summary: 'y'.repeat(5000) })).toBe('payload_too_large');
  });
});

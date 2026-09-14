import { describe, expect, it } from 'vitest';
import { parseSse } from './coach-stream';

describe('parseSse', () => {
  it('returns complete events and keeps the unfinished tail for the next read', () => {
    const r = parseSse('event: stage\ndata: {"stage":"retrieving"}\n\nevent: token\ndata: {"delta":"發酵"}\n\nevent: tok');
    expect(r.events).toEqual([
      { event: 'stage', data: { stage: 'retrieving' } },
      { event: 'token', data: { delta: '發酵' } },
    ]);
    expect(r.rest).toBe('event: tok');
    expect(parseSse(r.rest + 'en\ndata: {"delta":"溫度"}\n\n').events).toEqual([{ event: 'token', data: { delta: '溫度' } }]);
  });

  it('skips keep-alive comments and malformed events', () => {
    expect(parseSse(': ping\n\nevent: stage\ndata: not-json\n\nevent: stage\n\n').events).toEqual([]);
  });
});

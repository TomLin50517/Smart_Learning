import { describe, expect, it } from 'vitest';
import { keepDumps, parseStamp } from './backup.js';

const name = (iso: string) => `iac-${iso.replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}.dump`;

describe('parseStamp', () => {
  it('reads the timestamp out of a dump filename', () => {
    expect(parseStamp('iac-20260916-030000.dump')?.toISOString()).toBe('2026-09-16T03:00:00.000Z');
    expect(parseStamp('something-else.txt')).toBeNull();
  });
});

describe('keepDumps (7 daily + 4 weekly + 6 monthly)', () => {
  it('keeps the newest daily dumps and drops the rest', () => {
    const names = Array.from({ length: 10 }, (_, i) => name(`2026-09-${String(20 - i).padStart(2, '0')}T03:00:00`));
    const dropped = keepDumps(names, { daily: 7, weekly: 0, monthly: 0 });
    expect(dropped).toHaveLength(3);
    expect(dropped).toEqual([name('2026-09-13T03:00:00'), name('2026-09-12T03:00:00'), name('2026-09-11T03:00:00')]);
  });

  it('keeps Sundays and first-of-month beyond the daily window', () => {
    // 2026-09-06 與 2026-08-30 是週日；2026-09-01 與 2026-08-01 是每月 1 日
    const names = ['2026-09-16', '2026-09-06', '2026-09-01', '2026-08-30', '2026-08-01', '2026-07-15'].map((d) => name(`${d}T03:00:00`));
    const dropped = keepDumps(names, { daily: 1, weekly: 2, monthly: 2 });
    expect(dropped).toEqual([name('2026-07-15T03:00:00')]);
  });

  it('ignores files that are not dumps', () => {
    expect(keepDumps(['readme.txt', 'iac-latest.dump'], { daily: 0, weekly: 0, monthly: 0 })).toEqual([]);
  });
});

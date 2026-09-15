import { describe, expect, it } from 'vitest';
import { courseCutoff, coveringRelearning, type RelearningCover } from './relearning.js';

const acts = [
  { id: 'a1', moduleId: 'm1', lessonId: 'l1' },
  { id: 'a2', moduleId: 'm1', lessonId: 'l2' },
  { id: 'a3', moduleId: 'm2', lessonId: 'l3' },
];
const r = (id: string, scopeType: RelearningCover['scopeType'], scopeId: string | null, at: number): RelearningCover => ({ id, scopeType, scopeId, at, policy: 'reset_counter' });
const ids = (cov: Record<string, RelearningCover>) => Object.fromEntries(Object.entries(cov).map(([k, v]) => [k, v.id]));

describe('coveringRelearning', () => {
  it('the latest assignment covering an activity wins, whatever the input order', () => {
    expect(ids(coveringRelearning([r('x', 'module', 'm1', 2), r('z', 'activity', 'a1', 3), r('y', 'course', null, 1)], acts))).toEqual({ a1: 'z', a2: 'x', a3: 'y' });
  });

  it('a later course-wide assignment covers everything again', () => {
    expect(ids(coveringRelearning([r('z', 'activity', 'a1', 3), r('c', 'course', null, 4)], acts))).toEqual({ a1: 'c', a2: 'c', a3: 'c' });
  });

  it('a lesson covers only its own activities; no assignments covers nothing', () => {
    expect(ids(coveringRelearning([r('l', 'lesson', 'l2', 1)], acts))).toEqual({ a2: 'l' });
    expect(coveringRelearning([], acts)).toEqual({});
  });
});

describe('courseCutoff', () => {
  it('is the time of the latest course-wide assignment', () => {
    expect(courseCutoff([r('a', 'course', null, 1), r('b', 'module', 'm1', 5), r('c', 'course', null, 3)])).toBe(3);
    expect(courseCutoff([r('b', 'module', 'm1', 5)])).toBeNull();
  });
});

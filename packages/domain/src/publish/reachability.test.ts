import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';
import { checkReachability, type ReachabilityInput } from './reachability.js';

const act = (id: string, prerequisite: unknown = null, isRequired = true) => ({ id, title: id, isRequired, prerequisite });
const done = (...ids: string[]) => ({ type: 'specific_activities_completed', activity_ids: ids });

function course(mode: ReachabilityInput['navigationMode'], m1: ReturnType<typeof act>[], m2: ReturnType<typeof act>[] = []): ReachabilityInput {
  return {
    navigationMode: mode,
    modules: [
      { id: 'M1', title: '單元一', isRequired: true, lessons: [{ id: 'L1', title: '課節一', isRequired: true, activities: m1 }] },
      ...(m2.length ? [{ id: 'M2', title: '單元二', isRequired: true, lessons: [{ id: 'L2', title: '課節二', isRequired: true, activities: m2 }] }] : []),
    ],
  };
}

const unreachable = (input: ReachabilityInput) => {
  const r = checkReachability(input);
  return { errors: r.errors.map((e) => e.targetId), warnings: r.warnings.map((w) => `${w.code}:${w.targetId}`) };
};

describe('checkReachability (C1)', () => {
  it('a plain course is fully reachable', () => {
    expect(unreachable(course('mixed', [act('A'), act('B', done('A'))], [act('C')]))).toEqual({ errors: [], warnings: [] });
  });

  it('a prerequisite cycle makes both activities unreachable, and anything depending on them', () => {
    expect(unreachable(course('free', [act('A', done('B')), act('B', done('A')), act('C', done('B')), act('D')])).errors).toEqual(['A', 'B', 'C']);
  });

  it('self-dependency is unreachable', () => {
    expect(unreachable(course('free', [act('A', done('A'))])).errors).toEqual(['A']);
  });

  it('strict ordering plus a prerequisite on a later activity forms a cycle', () => {
    expect(unreachable(course('strict', [act('A', done('B')), act('B')])).errors).toEqual(['A', 'B']);
    // free 模式下同樣的先修條件沒有問題
    expect(unreachable(course('free', [act('A', done('B')), act('B')])).errors).toEqual([]);
  });

  it('mixed mode: a module-1 activity requiring module 2 is circular', () => {
    expect(unreachable(course('mixed', [act('A', done('C'))], [act('C')])).errors).toEqual(['A', 'C']);
  });

  it('OR branches and negated conditions are not mandatory dependencies', () => {
    const or = { operator: 'OR', conditions: [done('B'), { type: 'minimum_activity_score', activity_id: 'X', value: 1 }] };
    expect(unreachable(course('free', [act('A', or), act('B', done('A'))])).errors).toEqual([]);
    expect(unreachable(course('free', [act('A', { ...done('B'), negate: true }), act('B', done('A'))])).errors).toEqual([]);
  });

  it('requiring an empty scope blocks the activity; optional activities only warn', () => {
    const input = course('free', [act('A', { type: 'lesson_completed', lesson_id: 'L2' }), act('O', done('O'), false)], [act('Z', null, false)]);
    const r = checkReachability(input);
    expect(r.errors.map((e) => e.targetId)).toEqual(['A']);
    expect(r.errors[0]!.message).toContain('沒有必修活動');
    expect(r.warnings.map((w) => `${w.code}:${w.targetId}`)).toEqual(['C1_EMPTY_REQUIRED_SCOPE:L2', 'C1_EMPTY_REQUIRED_SCOPE:M2', 'C1_UNREACHABLE:O']);
  });

  it('reports structure paths for jumping to the activity', () => {
    const r = checkReachability(course('free', [act('A'), act('B', done('B'))]));
    expect(r.errors[0]).toMatchObject({ check: 'C1', code: 'C1_UNREACHABLE', path: 'modules.0.lessons.0.activities.1' });
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it('omits undefined keys and escapes strings like JSON', () => {
    expect(canonicalJson({ a: undefined, b: '引號"與\\' })).toBe('{"b":"引號\\"與\\\\"}');
  });
});

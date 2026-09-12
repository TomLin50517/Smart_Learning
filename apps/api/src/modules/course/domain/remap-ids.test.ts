import { describe, expect, it } from 'vitest';
import { remapIds } from './remap-ids.js';

const OLD_A = '11111111-1111-1111-1111-111111111111';
const OLD_B = '22222222-2222-2222-2222-222222222222';
const NEW_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NEW_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const map = new Map([
  [OLD_A, NEW_A],
  [OLD_B, NEW_B],
]);

describe('remapIds', () => {
  it('rewrites ids inside a completion rule (nested groups, arrays, single ids)', () => {
    const rule = {
      operator: 'AND',
      conditions: [
        { type: 'specific_activities_completed', activity_ids: [OLD_A, OLD_B] },
        { operator: 'OR', conditions: [{ type: 'minimum_activity_score', activity_id: OLD_B, value: 60 }] },
      ],
    };
    expect(remapIds(rule, map)).toEqual({
      operator: 'AND',
      conditions: [
        { type: 'specific_activities_completed', activity_ids: [NEW_A, NEW_B] },
        { operator: 'OR', conditions: [{ type: 'minimum_activity_score', activity_id: NEW_B, value: 60 }] },
      ],
    });
  });

  it('rewrites object keys that are ids (e.g. answer keys keyed by activity)', () => {
    expect(remapIds({ answers: { [OLD_A]: 'x' } }, map)).toEqual({ answers: { [NEW_A]: 'x' } });
  });

  it('leaves unrelated strings, numbers, booleans and null untouched and does not mutate the input', () => {
    const input = { title: OLD_A.slice(0, 8), n: 3, ok: true, none: null, blocks: [{ type: 'activity', activityId: OLD_A }] };
    const copy = structuredClone(input);
    expect(remapIds(input, map)).toEqual({ title: OLD_A.slice(0, 8), n: 3, ok: true, none: null, blocks: [{ type: 'activity', activityId: NEW_A }] });
    expect(input).toEqual(copy);
  });
});

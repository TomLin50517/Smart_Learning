import { PLATFORM_SETTINGS } from '@iac/contracts';
import { describe, expect, it } from 'vitest';
import { SettingsPatch } from './platform-settings.service.js';

describe('SettingsPatch — only catalogued keys, in range, integers', () => {
  it('accepts a partial update and null (reset to default)', () => {
    expect(SettingsPatch.parse({ 'derived.min_threshold': 8 })).toEqual({ 'derived.min_threshold': 8 });
    expect(SettingsPatch.parse({ 'upload.max_size': null })).toEqual({ 'upload.max_size': null });
  });

  it.each<[unknown, string]>([
    [{ 'not.a.setting': 1 }, 'unknown key'],
    [{ 'derived.min_threshold': 1 }, 'below min'],
    [{ 'derived.min_threshold': 101 }, 'above max'],
    [{ 'derived.min_threshold': 5.5 }, 'not an integer'],
    [{ 'derived.min_threshold': '8' }, 'string'],
    [{}, 'nothing to update'],
  ])('rejects %j (%s)', (body) => {
    expect(SettingsPatch.safeParse(body).success).toBe(false);
  });

  it('every catalogue default lies inside its own range', () => {
    for (const [key, d] of Object.entries(PLATFORM_SETTINGS)) {
      expect(d.default, key).toBeGreaterThanOrEqual(d.min);
      expect(d.default, key).toBeLessThanOrEqual(d.max);
    }
  });
});

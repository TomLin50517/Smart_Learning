import { describe, expect, it } from 'vitest';
import { contrastWithWhite, darkVariant, DEFAULT_PLATFORM_NAME, MIN_BRAND_CONTRAST, resolveBranding, THEME_KEYS, THEME_PRESETS } from './branding.js';

describe('branding colors', () => {
  it('every preset keeps white text readable on the main color', () => {
    for (const k of THEME_KEYS) expect(contrastWithWhite(THEME_PRESETS[k].light), k).toBeGreaterThanOrEqual(MIN_BRAND_CONTRAST);
  });

  it('computes WCAG contrast and a lighter dark-mode variant', () => {
    expect(contrastWithWhite('#ffffff')).toBe(1);
    expect(contrastWithWhite('#000000')).toBe(21);
    expect(contrastWithWhite('#fde047')).toBeLessThan(MIN_BRAND_CONTRAST);
    expect(darkVariant('#000000')).toBe('#737373');
    expect(darkVariant('#1d4ed8')).not.toBe('#1d4ed8');
  });

  it('resolves presets, custom colors and defaults; ignores unknown values', () => {
    expect(resolveBranding({ code: 'abc', branding: {} })).toEqual({
      theme: 'academy_blue',
      colors: { light: '#1d4ed8', dark: '#7c9bff' },
      platformName: DEFAULT_PLATFORM_NAME,
      logoUrl: null,
      iconUrl: null,
    });
    const custom = resolveBranding({ code: 'abc', branding: { theme: 'teal', customColor: '#7C2D12', platformName: ' ABC 學苑 ' }, logoSha: 'a'.repeat(64) });
    expect(custom).toMatchObject({ theme: 'custom', colors: { light: '#7c2d12' }, platformName: 'ABC 學苑', logoUrl: `/api/branding/abc/logo?v=${'a'.repeat(12)}` });
    expect(resolveBranding({ code: 'abc', branding: { theme: 'neon', customColor: 'red' } }).theme).toBe('academy_blue');
  });
});

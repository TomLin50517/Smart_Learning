import { describe, expect, it } from 'vitest';
import { csrfMatches, csrfTokenFor } from './csrf.js';

const SECRET = 'unit-test-secret-unit-test-secret';

describe('csrfTokenFor', () => {
  it('is deterministic for the same session', () => {
    expect(csrfTokenFor('s1', SECRET)).toBe(csrfTokenFor('s1', SECRET));
  });

  it('differs per session — a token cannot be replayed on another session', () => {
    expect(csrfTokenFor('s1', SECRET)).not.toBe(csrfTokenFor('s2', SECRET));
  });

  it('differs per secret — cannot be forged without SESSION_SECRET', () => {
    expect(csrfTokenFor('s1', SECRET)).not.toBe(csrfTokenFor('s1', 'another-secret-another-secret-xx'));
  });
});

describe('csrfMatches (double submit)', () => {
  const t = csrfTokenFor('s1', SECRET);

  it('header and cookie both equal the expected token → ok', () => {
    expect(csrfMatches(t, t, t)).toBe(true);
  });

  it('missing header → rejected', () => {
    expect(csrfMatches(t, undefined, t)).toBe(false);
  });

  it('header present but cookie missing → rejected', () => {
    expect(csrfMatches(t, t, undefined)).toBe(false);
  });

  it("token from another session → rejected", () => {
    const other = csrfTokenFor('s2', SECRET);
    expect(csrfMatches(t, other, other)).toBe(false);
  });

  it('different length is rejected without throwing', () => {
    expect(csrfMatches(t, 'short', 'short')).toBe(false);
  });
});

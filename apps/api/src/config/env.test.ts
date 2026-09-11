import { describe, expect, it } from 'vitest';
import { loadEnv, parseTrustProxy } from './env.js';

describe('parseTrustProxy — who may set X-Forwarded-For', () => {
  it('defaults to trusting nobody', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
  });

  it('a hop count trusts exactly that many nearest proxies', () => {
    const trust = parseTrustProxy('1') as (address: string, hop: number) => boolean;
    expect(typeof trust).toBe('function');
    expect(trust('10.0.0.1', 0)).toBe(true); // nginx
    expect(trust('203.0.113.9', 1)).toBe(false); // client-supplied hop — not trusted
  });

  it('a CSV becomes an allow-list of proxy addresses / CIDRs', () => {
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8')).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });

  it("'true' trusts every proxy (explicit opt-in only)", () => {
    expect(parseTrustProxy('true')).toBe(true);
  });
});

describe('loadEnv — secure defaults', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    DATABASE_URL_COACH: 'postgres://y',
    SESSION_SECRET: 'x'.repeat(32),
  };

  it('cookies are Secure and proxies untrusted unless configured otherwise', () => {
    const env = loadEnv(base);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.TRUST_PROXY).toBe('false');
    expect(env.AI_PROVIDER).toBe('none');
  });

  it('COOKIE_SECURE=false is honoured (local HTTP debugging)', () => {
    expect(loadEnv({ ...base, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('production refuses license overrides — they would allow self-signed licenses / fake hardware', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', LICENSE_PUBLIC_KEY_OVERRIDE: 'x' })).toThrow(/LICENSE_PUBLIC_KEY_OVERRIDE/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', LICENSE_FINGERPRINT_OVERRIDE: 'x' })).toThrow(/LICENSE_FINGERPRINT_OVERRIDE/);
  });

  it('production refuses insecure cookies and a plain-http activation service', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', LICENSE_ACTIVATION_URL: 'http://vendor.example/act' })).toThrow(/https/);
    expect(loadEnv({ ...base, NODE_ENV: 'production', LICENSE_ACTIVATION_URL: 'https://vendor.example/act' }).NODE_ENV).toBe('production');
  });

  it('overrides remain available outside production (dev / tests)', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'test', LICENSE_FINGERPRINT_OVERRIDE: 'sha256:x' }).LICENSE_FINGERPRINT_OVERRIDE).toBe('sha256:x');
  });

  it('rejects a short SESSION_SECRET', () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'too-short' })).toThrow(/SESSION_SECRET/);
  });
});

describe('loadEnv — SMTP (SD §8.10)', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    DATABASE_URL_COACH: 'postgres://y',
    SESSION_SECRET: 'x'.repeat(32),
  };
  const smtp = { ...base, SMTP_HOST: 'mail.example.test', SMTP_FROM: 'Platform <no-reply@example.test>' };

  it('is off by default; once enabled, STARTTLS is required by default', () => {
    const off = loadEnv(base);
    expect(off.SMTP_HOST).toBe('');
    const on = loadEnv(smtp);
    expect(on).toMatchObject({ SMTP_PORT: 587, SMTP_SECURE: false, SMTP_REQUIRE_TLS: true });
  });

  it('SMTP_HOST without a usable SMTP_FROM is rejected at startup', () => {
    expect(() => loadEnv({ ...base, SMTP_HOST: 'mail.example.test' })).toThrow(/SMTP_FROM/);
    expect(() => loadEnv({ ...smtp, SMTP_FROM: 'no address' })).toThrow(/SMTP_FROM/);
  });

  it('SMTP_USER without SMTP_PASSWORD is rejected', () => {
    expect(() => loadEnv({ ...smtp, SMTP_USER: 'mailer' })).toThrow(/SMTP_PASSWORD/);
    expect(loadEnv({ ...smtp, SMTP_USER: 'mailer', SMTP_PASSWORD: 'p' }).SMTP_USER).toBe('mailer');
  });

  it('production refuses plaintext SMTP (emails carry one-time tokens); STARTTLS or implicit TLS are fine', () => {
    const prod = { ...smtp, NODE_ENV: 'production' };
    expect(() => loadEnv({ ...prod, SMTP_REQUIRE_TLS: 'false' })).toThrow(/plaintext SMTP/);
    expect(loadEnv(prod).SMTP_REQUIRE_TLS).toBe(true);
    expect(loadEnv({ ...prod, SMTP_SECURE: 'true', SMTP_PORT: '465', SMTP_REQUIRE_TLS: 'false' }).SMTP_SECURE).toBe(true);
  });

  it('plaintext SMTP remains possible outside production (local test servers)', () => {
    expect(loadEnv({ ...smtp, NODE_ENV: 'test', SMTP_REQUIRE_TLS: 'false' }).SMTP_REQUIRE_TLS).toBe(false);
  });
});

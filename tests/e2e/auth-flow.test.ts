/**
 * 認證流程端到端測試（SD §8.1、§8.2、§8.8；THR-S-001/002/003）。
 * 真實 PostgreSQL 18 + 全部 migration；寄信以攔截替身取代，以取得重設 token。
 */
import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { hashPassword } from '../../apps/api/src/modules/identity/infrastructure/password-hasher.js';
import { ACCOUNT_MAILER, type AccountMailer } from '../../apps/api/src/modules/notification/notification.contracts.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const ORG = '22222222-0000-0000-0000-00000000000a';
const ALICE = { id: 'bbbbbbbb-0000-0000-0000-00000000000a', email: 'alice@e2e.test', password: 'alice-correct-horse' };
const BOB = { id: 'bbbbbbbb-0000-0000-0000-00000000000b', email: 'bob@e2e.test', password: 'bob-correct-horse' };
const CAROL = { id: 'bbbbbbbb-0000-0000-0000-00000000000c', email: 'carol@e2e.test', password: 'carol-correct-horse' };
const DAVE = { id: 'bbbbbbbb-0000-0000-0000-00000000000d', email: 'dave@e2e.test', password: 'dave-correct-horse' };
const FAST = { memory: 64, passes: 1, parallelism: 1, tagLength: 32 };

class CaptureMailer implements AccountMailer {
  readonly sent: { to: string; link: string }[] = [];
  private waiters: ((m: { to: string; link: string }) => void)[] = [];
  async sendPasswordReset(m: { to: string; link: string }): Promise<void> {
    this.push({ to: m.to, link: m.link });
  }
  async sendInvitation(m: { to: string; link: string }): Promise<void> {
    this.push({ to: m.to, link: m.link });
  }
  private push(m: { to: string; link: string }): void {
    this.sent.push(m);
    this.waiters.shift()?.(m);
  }
  next(): Promise<{ to: string; link: string }> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const mailer = new CaptureMailer();
let ipSeq = 10;
/** 每個情境用不同來源 IP，避免 IP 限額（20/分）在測試間互相干擾 */
const nextIp = () => `10.0.0.${ipSeq++}`;

interface Jar {
  session?: string;
  csrf?: string;
}

async function login(email: string, password: string, ip = nextIp()) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { email, password } });
  const jar: Jar = {};
  for (const c of res.cookies as { name: string; value: string }[]) {
    if (c.name === 'iac_session') jar.session = c.value;
    if (c.name === 'iac_csrf') jar.csrf = c.value;
  }
  return { res, jar };
}

const cookieHeader = (j: Jar) => [j.session && `iac_session=${j.session}`, j.csrf && `iac_csrf=${j.csrf}`].filter(Boolean).join('; ');
const me = (j: Jar) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieHeader(j) } });
/** csrfHeader 傳 null 表示「不送 header」——不能用 undefined，那會觸發預設值 */
const post = (url: string, j: Jar, csrfHeader: string | null = j.csrf ?? null) =>
  app.inject({
    method: 'POST',
    url,
    headers: { cookie: cookieHeader(j), ...(csrfHeader !== null ? { 'x-csrf-token': csrfHeader } : {}) },
  });

/**
 * 登入並斷言成功。注意：帳號限額（5/分）計算所有嘗試、不論成敗——
 * 同一使用者在同一分鐘內登入超過 5 次會被 429，因此各情境分用不同使用者。
 */
async function loginOk(email: string, password: string) {
  const r = await login(email, password);
  expect(r.res.statusCode, `login ${email}`).toBe(200);
  return r;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-auth', 'Org Auth', 'auth')`, [ORG]);
  for (const u of [ALICE, BOB, CAROL, DAVE]) {
    // 以低成本參數建立，驗證登入後會自動升級為正式參數（needsRehash）
    await admin.query(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`, [
      u.id,
      u.email,
      u.email.split('@')[0],
      await hashPassword(u.password, FAST),
    ]);
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
       SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [u.id, ORG],
    );
  }

  const h = container.getHost();
  const p = container.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
        SESSION_SECRET: 'auth-flow-secret-auth-flow-secret-xx',
        LICENSE_FINGERPRINT_OVERRIDE: 'sha256:e2e',
        LOGIN_MAX_FAILURES: '3',
        PUBLIC_BASE_URL: 'https://learn.example.test',
      }),
    )
    .overrideProvider(ACCOUNT_MAILER)
    .useValue(mailer)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('login', () => {
  it('success → 200, secure cookies, CSRF token in body matches cookie, /me works', async () => {
    const { res, jar } = await login(ALICE.email, ALICE.password);
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies as { name: string; httpOnly?: boolean; secure?: boolean; sameSite?: string }[];
    const session = cookies.find((c) => c.name === 'iac_session')!;
    const csrf = cookies.find((c) => c.name === 'iac_csrf')!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(csrf.httpOnly ?? false).toBe(false);
    expect(res.json().csrfToken).toBe(jar.csrf);
    expect((await me(jar)).json().user.id).toBe(ALICE.id);
  });

  it('upgrades a weak password hash to production parameters on login', async () => {
    const r = await admin.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [ALICE.id]);
    expect(r.rows[0]!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('writes auth.login.succeeded with the user as actor', async () => {
    const r = await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'auth.login.succeeded' AND actor_user_id = $1`, [ALICE.id]);
    expect(r.rowCount).toBeGreaterThan(0);
  });

  it('wrong password and unknown account are indistinguishable to the client', async () => {
    const wrong = await login(ALICE.email, 'nope-nope-nope');
    const unknown = await login('nobody@e2e.test', 'nope-nope-nope');
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, correlation_id: undefined });
    expect(strip(wrong.res.json())).toEqual(strip(unknown.res.json()));
    expect(wrong.res.json().error.message).toBe('Invalid email or password');
  });

  it('failure reason is recorded only in audit, and unknown emails are not stored', async () => {
    const r = await admin.query<{ reason: string; actor_user_id: string | null }>(
      `SELECT metadata->>'reason' AS reason, actor_user_id FROM audit_logs WHERE action = 'auth.login.failed' ORDER BY occurred_at`,
    );
    expect(r.rows).toEqual(
      expect.arrayContaining([
        { reason: 'bad_password', actor_user_id: ALICE.id },
        { reason: 'unknown_account', actor_user_id: null },
      ]),
    );
    const leaked = await admin.query(`SELECT 1 FROM audit_logs WHERE metadata::text LIKE '%nobody@e2e.test%'`);
    expect(leaked.rowCount).toBe(0);
  });

  it('malformed input → 400 VALIDATION_FAILED without echoing the password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: nextIp(), payload: { email: 'not-an-email', password: 'Secr3t-Value' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'email' })]));
    expect(res.body).not.toContain('Secr3t-Value');
  });
});

describe('lockout (LOGIN_MAX_FAILURES = 3)', () => {
  it('locks after 3 failures; even the correct password is then rejected with the same message', async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i++) expect((await login(BOB.email, 'wrong-wrong-wrong', ip)).res.statusCode).toBe(401);

    const locked = await admin.query<{ locked: boolean }>(`SELECT locked_until > now() AS locked FROM users WHERE id = $1`, [BOB.id]);
    expect(locked.rows[0]!.locked).toBe(true);

    const res = (await login(BOB.email, BOB.password, ip)).res;
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid email or password');
  });
});

describe('rate limiting', () => {
  it('per-account limit (5/min) → 429 RATE_LIMITED with Retry-After', async () => {
    const ip = nextIp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login('ratelimit@e2e.test', 'x-x-x-x-x', ip)).res.statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);

    const res = (await login('ratelimit@e2e.test', 'x-x-x-x-x', nextIp())).res; // 換 IP 仍被帳號限額擋下
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('account bucket keys are hashed — no raw email in the counter table', async () => {
    const r = await admin.query(`SELECT 1 FROM rate_limit_counters WHERE bucket LIKE '%@%'`);
    expect(r.rowCount).toBe(0);
  });
});

describe('CSRF (state-changing requests while logged in)', () => {
  it('missing header → 403 CSRF_TOKEN_INVALID', async () => {
    const { jar } = await loginOk(CAROL.email, CAROL.password);
    const res = await post('/api/auth/refresh', jar, null);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it("another session's token → 403", async () => {
    const a = await loginOk(CAROL.email, CAROL.password);
    const b = await loginOk(CAROL.email, CAROL.password);
    const res = await post('/api/auth/refresh', a.jar, b.jar.csrf ?? null);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_TOKEN_INVALID');
  });
});

describe('refresh / logout / idle timeout', () => {
  it('refresh rotates session and CSRF token; the old session stops working', async () => {
    const { jar } = await loginOk(DAVE.email, DAVE.password);
    const res = await post('/api/auth/refresh', jar);
    expect(res.statusCode).toBe(200);
    const next: Jar = {};
    for (const c of res.cookies as { name: string; value: string }[]) {
      if (c.name === 'iac_session') next.session = c.value;
      if (c.name === 'iac_csrf') next.csrf = c.value;
    }
    expect(next.session).not.toBe(jar.session);
    expect(next.csrf).not.toBe(jar.csrf);
    expect((await me(jar)).statusCode).toBe(401);
    expect((await me(next)).statusCode).toBe(200);
  });

  it('logout → 204, session revoked, auth.logout audited', async () => {
    const { jar } = await loginOk(DAVE.email, DAVE.password);
    const res = await post('/api/auth/logout', jar);
    expect(res.statusCode).toBe(204);
    expect((await me(jar)).statusCode).toBe(401);
    const r = await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'auth.logout' AND actor_user_id = $1`, [DAVE.id]);
    expect(r.rowCount).toBeGreaterThan(0);
  });

  it('idle longer than SESSION_IDLE_MINUTES → 401', async () => {
    const { jar } = await loginOk(DAVE.email, DAVE.password);
    await admin.query(`UPDATE user_sessions SET last_seen_at = now() - interval '31 minutes' WHERE session_token_hash = $1`, [
      hashToken(jar.session!),
    ]);
    expect((await me(jar)).statusCode).toBe(401);
  });
});

describe('password reset', () => {
  it('request → 202 and a one-time link; token stored only as a hash', async () => {
    const mail = mailer.next();
    const res = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: nextIp(), payload: { email: ALICE.email } });
    expect(res.statusCode).toBe(202);

    const { to, link } = await mail;
    expect(to).toBe(ALICE.email);
    expect(link).toMatch(/^https:\/\/learn\.example\.test\/password-reset\?token=/);
    const token = new URL(link).searchParams.get('token')!;

    const r = await admin.query<{ token_hash: string }>(`SELECT token_hash FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [ALICE.id]);
    expect(r.rows).toEqual([{ token_hash: hashToken(token) }]);
    (globalThis as { __resetToken?: string }).__resetToken = token;
  });

  it('unknown email → same 202, no mail sent', async () => {
    const before = mailer.sent.length;
    const res = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: nextIp(), payload: { email: 'ghost@e2e.test' } });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(mailer.sent.length).toBe(before);
  });

  it('confirm: weak password rejected, valid one accepted, all sessions revoked, token single-use', async () => {
    const token = (globalThis as { __resetToken?: string }).__resetToken!;
    const existing = await login(ALICE.email, ALICE.password);
    expect((await me(existing.jar)).statusCode).toBe(200);

    const confirm = (newPassword: string) =>
      app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', remoteAddress: nextIp(), payload: { token, newPassword } });

    expect((await confirm('short')).statusCode).toBe(400);
    expect((await confirm('alice-brand-new-passphrase')).statusCode).toBe(204);

    expect((await me(existing.jar)).statusCode).toBe(401); // 既有 session 全部撤銷
    expect((await login(ALICE.email, ALICE.password)).res.statusCode).toBe(401);
    expect((await login(ALICE.email, 'alice-brand-new-passphrase')).res.statusCode).toBe(200);

    const reuse = await confirm('yet-another-passphrase');
    expect(reuse.statusCode).toBe(422);
    expect(reuse.json().error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
  });
});

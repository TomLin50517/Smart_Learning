/**
 * 規格缺口補齊的端到端測試（SD §8.12、ADR-033）：切換組織、個人資料、變更密碼、管理員復原。
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { hashPassword, verifyPassword } from '../../apps/api/src/modules/identity/infrastructure/password-hasher.js';
import { ACCOUNT_MAILER, type AccountMailer } from '../../apps/api/src/modules/notification/notification.contracts.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'gaps-e2e-secret-gaps-e2e-secret-gaps-e2e';
const FINGERPRINT = 'sha256:e2e-gaps';
const FAST = { memory: 64, passes: 1, parallelism: 1, tagLength: 32 };
const ORG = {
  a: '12121212-0000-0000-0000-00000000000a',
  b: '12121212-0000-0000-0000-00000000000b',
  off: '12121212-0000-0000-0000-00000000000f', // 已停用
  c: '12121212-0000-0000-0000-00000000000c', // 唯一的管理員已停用 → 可復原
  d: '12121212-0000-0000-0000-00000000000d', // 仍有啟用中的管理員
};
const U = {
  multi: '34343434-0000-0000-0000-000000000001',
  padmin: '34343434-0000-0000-0000-000000000002',
  adminD: '34343434-0000-0000-0000-000000000003',
  goneAdminC: '34343434-0000-0000-0000-000000000004',
  learnerC: '34343434-0000-0000-0000-000000000005',
};
const MULTI_PASSWORD = 'multi-correct-horse-1';

class CaptureMailer implements AccountMailer {
  readonly invites: { to: string; organizationName: string }[] = [];
  async sendPasswordReset(): Promise<void> {}
  async sendInvitation(m: { to: string; organizationName: string }): Promise<void> {
    this.invites.push({ to: m.to, organizationName: m.organizationName });
  }
}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const mailer = new CaptureMailer();

async function session(userId: string, org: string | null = ORG.a) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { id: r.rows[0]!.id, token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
type S = Awaited<ReturnType<typeof session>>;

const call = (method: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, t: S, payload?: object, csrf = true) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${t.token}; iac_csrf=${t.csrf}`, ...(csrf && { 'x-csrf-token': t.csrf }) },
  });

const lastAudit = async (action: string) =>
  (await admin.query(`SELECT actor_user_id, resource_id, organization_id, before_state, after_state, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action]))
    .rows[0];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(
    `INSERT INTO organizations (id, code, name, storage_prefix, status) VALUES
       ($1, 'org-a', 'Org A', 'a', 'active'), ($2, 'org-b', 'Org B', 'b', 'active'), ($3, 'org-off', 'Org Off', 'off', 'disabled'),
       ($4, 'org-c', 'Org C', 'c', 'active'), ($5, 'org-d', 'Org D', 'd', 'active')`,
    [ORG.a, ORG.b, ORG.off, ORG.c, ORG.d],
  );
  await admin.query(
    `INSERT INTO users (id, email, display_name, password_hash, status) VALUES
       ($1, 'multi@gaps.test', 'Multi', $6, 'active'), ($2, 'padmin@gaps.test', 'P', NULL, 'active'),
       ($3, 'admin-d@gaps.test', 'Admin D', NULL, 'active'), ($4, 'gone@gaps.test', 'Gone', NULL, 'disabled'),
       ($5, 'learner-c@gaps.test', 'Learner C', NULL, 'active')`,
    [U.multi, U.padmin, U.adminD, U.goneAdminC, U.learnerC, await hashPassword(MULTI_PASSWORD, FAST)],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $6::uuid FROM roles WHERE code = 'learner'
     UNION ALL SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $7::uuid FROM roles WHERE code = 'learner'
     UNION ALL SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $8::uuid FROM roles WHERE code = 'learner'
     UNION ALL SELECT $2::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL SELECT $3::uuid, id, 'organization'::scope_type, $10::uuid, $10::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $4::uuid, id, 'organization'::scope_type, $9::uuid, $9::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $5::uuid, id, 'self'::scope_type, $5::uuid, $9::uuid FROM roles WHERE code = 'learner'`,
    [U.multi, U.padmin, U.adminD, U.goneAdminC, U.learnerC, ORG.a, ORG.b, ORG.off, ORG.c, ORG.d],
  );
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-gaps', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);

  const h = container.getHost();
  const p = container.getPort();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://app_api:${PW.api_pw}@${h}:${p}/iac`,
        DATABASE_URL_COACH: `postgres://app_coach:${PW.coach_pw}@${h}:${p}/iac`,
        SESSION_SECRET: SECRET,
        LICENSE_FINGERPRINT_OVERRIDE: FINGERPRINT,
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

describe('PUT /api/me/active-organization', () => {
  it('switches the current session only, to an organization the user belongs to', async () => {
    const s1 = await session(U.multi);
    const s2 = await session(U.multi);
    const res = await call('PUT', '/api/me/active-organization', s1, { organizationId: ORG.b });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeOrganization.id).toBe(ORG.b);
    expect((await call('GET', '/api/me', s1)).json().activeOrganization.id).toBe(ORG.b);
    expect((await call('GET', '/api/me', s2)).json().activeOrganization.id).toBe(ORG.a); // 其他 session 不受影響
  });

  it.each([
    ['an organization the user does not belong to', ORG.d],
    ['a disabled organization', ORG.off],
    ['a non-existent organization', '12121212-0000-0000-0000-000000000999'],
  ])('%s → 404', async (_label, org) => {
    const s = await session(U.multi);
    const res = await call('PUT', '/api/me/active-organization', s, { organizationId: org });
    expect(res.statusCode).toBe(404);
  });

  it('requires the CSRF token', async () => {
    const s = await session(U.multi);
    expect((await call('PUT', '/api/me/active-organization', s, { organizationId: ORG.b }, false)).json().error.code).toBe('CSRF_TOKEN_INVALID');
  });
});

describe('PATCH /api/me/profile', () => {
  it('updates name and locale, auditing only what changed', async () => {
    const s = await session(U.multi);
    const res = await call('PATCH', '/api/me/profile', s, { displayName: '  多組織使用者  ', locale: 'en' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ displayName: '多組織使用者', locale: 'en' });
    expect(await lastAudit('user.profile.updated')).toMatchObject({
      actor_user_id: U.multi,
      resource_id: U.multi,
      before_state: { displayName: 'Multi', locale: 'zh-TW' },
      after_state: { displayName: '多組織使用者', locale: 'en' },
    });
  });

  it.each([
    [{}, '', 'nothing_to_update'],
    [{ locale: 'fr' }, 'locale', 'invalid_value'],
    [{ email: 'evil@x.test' }, 'email', 'unrecognized_key'],
    [{ displayName: '   ' }, 'displayName', 'too_small'],
  ])('rejects %j', async (body, field, issue) => {
    const s = await session(U.multi);
    const res = await call('PATCH', '/api/me/profile', s, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toContainEqual({ field, issue });
  });
});

describe('POST /api/me/password', () => {
  it('wrong current password / same password / too short are rejected without changing anything', async () => {
    const s = await session(U.multi);
    const wrong = await call('POST', '/api/me/password', s, { currentPassword: 'nope', newPassword: 'another-long-password' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details).toEqual([{ field: 'currentPassword', issue: 'incorrect' }]);

    const same = await call('POST', '/api/me/password', s, { currentPassword: MULTI_PASSWORD, newPassword: MULTI_PASSWORD });
    expect(same.json().error.details).toEqual([{ field: 'newPassword', issue: 'same_as_current' }]);

    const short = await call('POST', '/api/me/password', s, { currentPassword: MULTI_PASSWORD, newPassword: 'short' });
    expect(short.json().error.details).toEqual([{ field: 'newPassword', issue: 'too_small' }]);
  });

  it('changes the password, keeps this session, revokes the others and voids open reset links', async () => {
    const current = await session(U.multi);
    const other = await session(U.multi);
    await admin.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, repeat('b', 64), now() + interval '1 hour')`, [U.multi]);

    const res = await call('POST', '/api/me/password', current, { currentPassword: MULTI_PASSWORD, newPassword: 'brand-new-password-2' });
    expect(res.statusCode).toBe(204);

    expect((await call('GET', '/api/me', current)).statusCode).toBe(200);
    expect((await call('GET', '/api/me', other)).statusCode).toBe(401);
    const hash = (await admin.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [U.multi])).rows[0]!.password_hash;
    expect(await verifyPassword('brand-new-password-2', hash)).toBe(true);
    const open = await admin.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [U.multi]);
    expect(open.rowCount).toBe(0);

    const a = await lastAudit('auth.password.changed');
    expect(a).toMatchObject({ actor_user_id: U.multi, resource_id: U.multi });
    expect(a.metadata.revoked_sessions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(a)).not.toContain('brand-new-password');
  });
});

describe('POST /api/organizations/{id}/admin-recovery (ADR-033)', () => {
  it('assigns a new admin when the organization has no active admin, and audits it under that organization', async () => {
    const s = await session(U.padmin, null);
    const res = await call('POST', `/api/organizations/${ORG.c}/admin-recovery`, s, { email: 'rescue@gaps.test', displayName: '救援管理員' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ invited: true, emailSent: true });
    expect(mailer.invites).toContainEqual({ to: 'rescue@gaps.test', organizationName: 'Org C' });

    const role = await admin.query(
      `SELECT 1 FROM user_org_roles uor JOIN roles r ON r.id = uor.role_id WHERE uor.user_id = $1 AND uor.organization_id = $2 AND r.code = 'org_admin'`,
      [res.json().userId, ORG.c],
    );
    expect(role.rowCount).toBe(1);
    expect(await lastAudit('org.role.assigned')).toMatchObject({
      actor_user_id: U.padmin,
      organization_id: ORG.c,
      metadata: { reason: 'admin_recovery', email: 'rescue@gaps.test', invited: true },
    });
  });

  it('refuses while an active admin exists (not a back door around org separation)', async () => {
    const s = await session(U.padmin, null);
    const again = await call('POST', `/api/organizations/${ORG.c}/admin-recovery`, s, { email: 'second@gaps.test', displayName: 'Second' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details).toEqual([{ issue: 'org_has_active_admin' }]);

    const d = await call('POST', `/api/organizations/${ORG.d}/admin-recovery`, s, { email: 'x@gaps.test', displayName: 'X' });
    expect(d.json().error.details).toEqual([{ issue: 'org_has_active_admin' }]);
  });

  it('can promote an existing member instead of creating an account', async () => {
    await admin.query(`UPDATE users SET status = 'disabled' WHERE email = 'rescue@gaps.test'`); // 救援管理員也離職了
    const s = await session(U.padmin, null);
    const res = await call('POST', `/api/organizations/${ORG.c}/admin-recovery`, s, { email: 'learner-c@gaps.test', displayName: 'ignored' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: U.learnerC, invited: false, emailSent: false });
  });

  it('only platform admins may use it', async () => {
    const s = await session(U.adminD, ORG.d);
    expect((await call('POST', `/api/organizations/${ORG.c}/admin-recovery`, s, { email: 'y@gaps.test', displayName: 'Y' })).statusCode).toBe(403);
  });
});

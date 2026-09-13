/**
 * 組織、成員與角色管理端到端測試（SA UC-ORG-001~004、ADR-019、INV-1）。
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
import { ACCOUNT_MAILER, type AccountMailer } from '../../apps/api/src/modules/notification/notification.contracts.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'org-e2e-secret-org-e2e-secret-org-e2e';
const FINGERPRINT = 'sha256:e2e-org-host';
const ORG_A = '44444444-0000-0000-0000-00000000000a';
const ORG_C = '44444444-0000-0000-0000-00000000000c';
const COURSE_A = '55555555-0000-0000-0000-00000000000a';
const COURSE_C = '55555555-0000-0000-0000-00000000000c';
const PADMIN = 'dddddddd-0000-0000-0000-000000000001';
const ADMIN_A = 'dddddddd-0000-0000-0000-00000000000a';
const LEARNER_A = 'dddddddd-0000-0000-0000-0000000000a1';
const MEMBER_C = 'dddddddd-0000-0000-0000-00000000000c';
const RACE_1 = 'dddddddd-0000-0000-0000-0000000000c1';
const RACE_2 = 'dddddddd-0000-0000-0000-0000000000c2';
const GONE_C = 'dddddddd-0000-0000-0000-0000000000c3'; // 已停用的 org_admin

class CaptureMailer implements AccountMailer {
  readonly sent: { to: string; link: string; kind: string }[] = [];
  private waiters: ((m: { to: string; link: string }) => void)[] = [];
  async sendPasswordReset(m: { to: string; link: string }) {
    this.push({ ...m, kind: 'reset' });
  }
  async sendInvitation(m: { to: string; link: string; organizationName: string }) {
    this.push({ to: m.to, link: m.link, kind: `invite:${m.organizationName}` });
  }
  private push(m: { to: string; link: string; kind: string }) {
    this.sent.push(m);
    this.waiters.shift()?.(m);
  }
  next() {
    return new Promise<{ to: string; link: string }>((r) => this.waiters.push(r));
  }
}

interface S {
  token: string;
  csrf: string;
}
let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const mailer = new CaptureMailer();
const s = {} as Record<'padmin' | 'adminA' | 'learnerA' | 'race1' | 'race2', S>;
let orgB = '';

async function session(userId: string): Promise<S> {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token)],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: S, payload?: unknown) =>
  app.inject({
    method,
    url,
    ...(payload !== undefined && { payload: payload as object }),
    headers: { cookie: `iac_session=${t.token}; iac_csrf=${t.csrf}`, 'x-csrf-token': t.csrf },
  });
const lastAudit = async (action: string) =>
  (await admin.query(`SELECT resource_id, before_state, after_state, actor_user_id FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action]))
    .rows[0];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  // 有效授權：可寫設定、最多 3 個組織
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-org', 'c', 'enterprise', 'perpetual', now(), $1, '{}', '{"max_organizations": 3}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);

  await admin.query(
    `INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-a', 'Org A', 'a'), ($2, 'org-c', 'Org C', 'c')`,
    [ORG_A, ORG_C],
  );
  await admin.query(
    `INSERT INTO courses (id, organization_id, code, title) VALUES ($1, $2, 'CA', 'Course A'), ($3, $4, 'CC', 'Course C')`,
    [COURSE_A, ORG_A, COURSE_C, ORG_C],
  );
  await admin.query(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, 'padmin@e2e.test', 'PAdmin'), ($2, 'admin@a.test', 'Admin A'),
       ($3, 'learner@a.test', 'Learner A'), ($4, 'member@c.test', 'Member C')`,
    [PADMIN, ADMIN_A, LEARNER_A, MEMBER_C],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT $1::uuid, id, 'platform'::scope_type, NULL::uuid, NULL::uuid FROM roles WHERE code = 'platform_admin'
     UNION ALL SELECT $2::uuid, id, 'organization'::scope_type, $5::uuid, $5::uuid FROM roles WHERE code = 'org_admin'
     UNION ALL SELECT $3::uuid, id, 'self'::scope_type, $3::uuid, $5::uuid FROM roles WHERE code = 'learner'
     UNION ALL SELECT $4::uuid, id, 'self'::scope_type, $4::uuid, $6::uuid FROM roles WHERE code = 'learner'`,
    [PADMIN, ADMIN_A, LEARNER_A, MEMBER_C, ORG_A, ORG_C],
  );
  // 組織 C：兩位啟用中的管理員與一位已停用的管理員（管理員保護測試用）
  await admin.query(
    `INSERT INTO users (id, email, display_name, status) VALUES
       ($1, 'race1@c.test', 'Race 1', 'active'), ($2, 'race2@c.test', 'Race 2', 'active'), ($3, 'gone@c.test', 'Gone', 'disabled')`,
    [RACE_1, RACE_2, GONE_C],
  );
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
     SELECT u, r.id, 'organization'::scope_type, $4::uuid, $4::uuid FROM roles r, unnest(ARRAY[$1, $2, $3]::uuid[]) AS u WHERE r.code = 'org_admin'`,
    [RACE_1, RACE_2, GONE_C, ORG_C],
  );
  s.padmin = await session(PADMIN);
  s.adminA = await session(ADMIN_A);
  s.learnerA = await session(LEARNER_A);
  s.race1 = await session(RACE_1);
  s.race2 = await session(RACE_2);

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

describe('creating an organization (platform admin)', () => {
  // 必須在建立 org B 之前：建立後即達授權上限（3 個組織），LicenseCapabilityGuard
  // 會先於重複代碼檢查回 LICENSE_LIMIT_EXCEEDED——這是正確的 guard 順序。
  it('duplicate code → 400 already_exists', async () => {
    const res = await call('POST', '/api/organizations', s.padmin, { code: 'org-a', name: 'Dup' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([{ field: 'code', issue: 'already_exists' }]);
  });

  it('creates org B with its first admin, who is invited and sets their own password', async () => {
    const mail = mailer.next();
    const res = await call('POST', '/api/organizations', s.padmin, {
      code: 'org-b',
      name: 'Org B',
      initialAdmin: { email: 'boss@b.test', displayName: 'Boss B' },
    });
    expect(res.statusCode).toBe(201);
    orgB = res.json().organization.id;
    expect(res.json().initialAdmin.invited).toBe(true);

    const { to, link } = await mail;
    expect(to).toBe('boss@b.test');
    expect(link).toMatch(/^https:\/\/learn\.example\.test\/set-password\?token=/);

    const token = new URL(link).searchParams.get('token')!;
    const set = await app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token, newPassword: 'boss-b-strong-passphrase' } });
    expect(set.statusCode).toBe(204);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'boss@b.test', password: 'boss-b-strong-passphrase' } });
    expect(login.statusCode).toBe(200);

    const audit = await lastAudit('org.created');
    expect(audit.resource_id).toBe(orgB);
    expect(audit.after_state).toMatchObject({ code: 'org-b', initialAdmin: 'boss@b.test' });
  });

  it('license max_organizations (3) → 403 LICENSE_LIMIT_EXCEEDED', async () => {
    const res = await call('POST', '/api/organizations', s.padmin, { code: 'org-d', name: 'Org D' });
    expect(res.json().error.code).toBe('LICENSE_LIMIT_EXCEEDED');
  });

  it('an org admin cannot create organizations', async () => {
    expect((await call('POST', '/api/organizations', s.adminA, { code: 'org-x', name: 'X' })).json().error.code).toBe('PERMISSION_DENIED');
  });
});

describe('visibility (INV-1 / ADR-019)', () => {
  it('platform admin lists all organizations; an org admin only their own', async () => {
    const all = (await call('GET', '/api/organizations', s.padmin)).json() as { code: string }[];
    expect(all.map((o) => o.code).sort()).toEqual(['org-a', 'org-b', 'org-c']);
    const mine = (await call('GET', '/api/organizations', s.adminA)).json() as { code: string }[];
    expect(mine.map((o) => o.code)).toEqual(['org-a']);
  });

  it("another organization's detail → 404, not 403", async () => {
    expect((await call('GET', `/api/organizations/${orgB}`, s.adminA)).statusCode).toBe(404);
  });

  it('a learner cannot open the organization list', async () => {
    expect((await call('GET', '/api/organizations', s.learnerA)).statusCode).toBe(403);
  });
});

describe('organization settings', () => {
  it('org admin renames and rebrands; audit keeps before/after', async () => {
    const res = await call('PATCH', `/api/organizations/${ORG_A}`, s.adminA, { name: 'Org A Renamed', branding: { primaryColor: '#123456' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Org A Renamed', branding: { primaryColor: '#123456' } });
    const audit = await lastAudit('org.updated');
    expect(audit.before_state).toMatchObject({ name: 'Org A' });
    expect(audit.after_state).toMatchObject({ name: 'Org A Renamed' });
  });

  it('arbitrary branding keys are rejected (no raw CSS / HTML)', async () => {
    const res = await call('PATCH', `/api/organizations/${ORG_A}`, s.adminA, { branding: { css: 'body{display:none}' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('members', () => {
  it('adding a new person creates an account without a password and sends an invitation', async () => {
    const mail = mailer.next();
    const res = await call('POST', `/api/organizations/${ORG_A}/users`, s.adminA, { email: 'new@a.test', displayName: 'New Person' });
    expect(res.statusCode).toBe(201);
    expect(res.json().invited).toBe(true);
    expect((await mail).to).toBe('new@a.test');
  });

  it('adding someone who already has an account links them without re-inviting', async () => {
    const before = mailer.sent.length;
    const res = await call('POST', `/api/organizations/${ORG_A}/users`, s.adminA, { email: 'boss@b.test', displayName: 'ignored' });
    expect(res.json().invited).toBe(false);
    expect(mailer.sent.length).toBe(before);
  });

  it('adding an existing member again → 400 already_member', async () => {
    const res = await call('POST', `/api/organizations/${ORG_A}/users`, s.adminA, { email: 'learner@a.test', displayName: 'x' });
    expect(res.json().error.details).toEqual([{ field: 'email', issue: 'already_member' }]);
  });

  it('member list shows roles and pending invitations; platform admin can read it (0016)', async () => {
    const res = await call('GET', `/api/organizations/${ORG_A}/users`, s.adminA);
    const byEmail = Object.fromEntries((res.json().data as { email: string }[]).map((m) => [m.email, m]));
    expect(byEmail['new@a.test']).toMatchObject({ pendingInvitation: true, roles: [{ role: 'learner' }] });
    expect(byEmail['admin@a.test']).toMatchObject({ roles: [{ role: 'org_admin' }] });
    expect((await call('GET', `/api/organizations/${ORG_A}/users`, s.padmin)).statusCode).toBe(200);
    expect((await call('GET', `/api/organizations/${ORG_A}/users`, s.learnerA)).statusCode).toBe(403);
  });

  it('pagination returns an opaque cursor', async () => {
    const page1 = (await call('GET', `/api/organizations/${ORG_A}/users?limit=2`, s.adminA)).json();
    expect(page1.data).toHaveLength(2);
    const page2 = (await call('GET', `/api/organizations/${ORG_A}/users?limit=2&cursor=${page1.meta.next_cursor}`, s.adminA)).json();
    const emails = [...page1.data, ...page2.data].map((m: { email: string }) => m.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('adds a teacher directly as instructor of a course — no learner role needed', async () => {
    const res = await call('POST', `/api/organizations/${ORG_A}/users`, s.adminA, {
      email: 'teacher@a.test',
      displayName: '王老師',
      role: 'instructor',
      courseId: COURSE_A,
    });
    expect(res.statusCode).toBe(201);
    expect((await lastAudit('org.user.created')).after_state).toMatchObject({ role: 'instructor', courseId: COURSE_A });

    const list = (await call('GET', `/api/organizations/${ORG_A}/users?role=instructor`, s.adminA)).json().data;
    expect(list).toEqual([
      expect.objectContaining({ email: 'teacher@a.test', roles: [{ role: 'instructor', courseId: COURSE_A, course: { code: 'CA', title: 'Course A' } }] }),
    ]);
    const roster = await admin.query(`SELECT staff_role FROM course_staff WHERE course_id = $1 AND user_id = $2`, [COURSE_A, res.json().userId]);
    expect(roster.rows).toEqual([{ staff_role: 'instructor' }]);
  });

  it.each<[object, string, string]>([
    [{ role: 'instructor' }, 'courseId', 'course_id_mismatch'],
    [{ role: 'learner', courseId: COURSE_A }, 'courseId', 'course_id_mismatch'],
    [{ role: 'course_admin', courseId: COURSE_C }, 'courseId', 'course_not_in_organization'],
  ])('adding a member with %j → 400', async (extra, field, issue) => {
    const res = await call('POST', `/api/organizations/${ORG_A}/users`, s.adminA, { email: 'nobody@a.test', displayName: 'N', ...extra });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([{ field, issue }]);
  });

  it('searches name or email (case-insensitive; LIKE wildcards are literal) and filters by role', async () => {
    const emails = async (qs: string) =>
      ((await call('GET', `/api/organizations/${ORG_A}/users?${qs}`, s.adminA)).json().data as { email: string }[]).map((m) => m.email);
    expect(await emails('q=TEACHER')).toEqual(['teacher@a.test']);
    expect(await emails(`q=${encodeURIComponent('王老')}`)).toEqual(['teacher@a.test']);
    expect(await emails(`q=${encodeURIComponent('%')}`)).toEqual([]);
    expect(await emails('role=org_admin')).toEqual(['admin@a.test']);
    expect(await emails('role=learner&q=learner')).toEqual(['learner@a.test']);
    expect((await call('GET', `/api/organizations/${ORG_A}/users?role=platform_admin`, s.adminA)).statusCode).toBe(400);
  });
});

describe('role assignment', () => {
  const setRoles = (userId: string, roles: unknown, t = s.adminA) => call('PATCH', `/api/organizations/${ORG_A}/users/${userId}/roles`, t, { roles });

  it('grants instructor on a course of this org; audit records before and after', async () => {
    const res = await setRoles(LEARNER_A, [{ role: 'learner' }, { role: 'instructor', courseId: COURSE_A }]);
    expect(res.statusCode).toBe(200);
    // 回應的課程角色附課程代碼與名稱，畫面不必另查
    expect(res.json().roles).toContainEqual({ role: 'instructor', courseId: COURSE_A, course: { code: 'CA', title: 'Course A' } });
    const audit = await lastAudit('org.role.assigned');
    expect(audit.before_state).toEqual({ roles: [{ role: 'learner' }] });
    expect(audit.after_state.roles).toEqual(expect.arrayContaining([{ role: 'instructor', courseId: COURSE_A }]));
  });

  it("a course belonging to another organization → 400", async () => {
    const res = await setRoles(LEARNER_A, [{ role: 'instructor', courseId: COURSE_C }]);
    expect(res.json().error.details).toEqual([{ field: 'roles', issue: 'course_not_in_organization' }]);
  });

  it('platform_admin cannot be granted through an organization endpoint', async () => {
    expect((await setRoles(LEARNER_A, [{ role: 'platform_admin' }])).statusCode).toBe(400);
  });

  it('course role without courseId → 400', async () => {
    expect((await setRoles(LEARNER_A, [{ role: 'instructor' }])).statusCode).toBe(400);
  });

  it('a user who is not a member of this org → 404', async () => {
    expect((await setRoles(MEMBER_C, [{ role: 'learner' }])).statusCode).toBe(404);
  });

  it('an admin cannot remove their own org_admin role → 400 cannot_remove_own_admin', async () => {
    const res = await setRoles(ADMIN_A, [{ role: 'learner' }]);
    expect(res.json().error.details).toEqual([{ field: 'roles', issue: 'cannot_remove_own_admin' }]);
  });

  it('a learner cannot assign roles', async () => {
    expect((await setRoles(LEARNER_A, [{ role: 'org_admin' }], s.learnerA)).statusCode).toBe(403);
  });
});

describe('disabling an organization', () => {
  it('disabled org becomes invisible to its members; enabling restores access', async () => {
    expect((await call('POST', `/api/organizations/${ORG_A}/disable`, s.padmin)).statusCode).toBe(200);
    expect((await call('GET', `/api/organizations/${ORG_A}`, s.adminA)).statusCode).toBe(404);
    expect((await lastAudit('org.disabled')).after_state).toEqual({ status: 'disabled' });

    expect((await call('POST', `/api/organizations/${ORG_A}/enable`, s.padmin)).statusCode).toBe(200);
    expect((await call('GET', `/api/organizations/${ORG_A}`, s.adminA)).statusCode).toBe(200);
  });

  it('an org admin cannot disable their own organization', async () => {
    expect((await call('POST', `/api/organizations/${ORG_A}/disable`, s.adminA)).statusCode).toBe(403);
  });
});

describe('org admin safeguards (organization C: two active admins + one disabled)', () => {
  const setRolesC = (userId: string, roles: unknown, t: S) => call('PATCH', `/api/organizations/${ORG_C}/users/${userId}/roles`, t, { roles });
  const activeAdmins = async () =>
    (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_org_roles uor JOIN roles ro ON ro.id = uor.role_id JOIN users u ON u.id = uor.user_id
          WHERE uor.organization_id = $1 AND ro.code = 'org_admin' AND u.status = 'active'`,
        [ORG_C],
      )
    ).rows[0]!.n;

  it('removing your own org_admin role is refused even while another admin exists', async () => {
    const res = await setRolesC(RACE_1, [{ role: 'learner' }], s.race1);
    expect(res.json().error.details).toEqual([{ field: 'roles', issue: 'cannot_remove_own_admin' }]);
  });

  /** 等到有 n 個連線卡在「鎖定組織列」這一步（最多約 3 秒；沒有這把鎖時不會有人等待） */
  async function waitForOrgLockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const r = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM organizations WHERE id = $1 FOR NO KEY UPDATE%'`,
      );
      if (r.rows[0]!.n >= n) return;
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  it('two admins removing each other at the same moment: exactly one succeeds, and the disabled admin does not count', async () => {
    // 測試端先鎖住組織列：兩個請求都通過權限檢查、停在同一把鎖前，再一起放行——
    // 確保兩者真的同時進入角色變更，而不是剛好一前一後（那樣後者只會在權限檢查被擋下）
    const blocker = new pg.Client({ connectionString: container.getConnectionUri() });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [ORG_C]);
    const pending = Promise.all([setRolesC(RACE_2, [{ role: 'learner' }], s.race1), setRolesC(RACE_1, [{ role: 'learner' }], s.race2)]);
    await waitForOrgLockWaiters(2);
    await blocker.query('ROLLBACK');
    await blocker.end();

    const [a, b] = await pending;
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const loser = a.statusCode === 400 ? a : b;
    expect(loser.json().error.details).toEqual([{ field: 'roles', issue: 'last_org_admin' }]);
    expect(await activeAdmins()).toBe(1);
  });
});

/**
 * 批次匯入（SD §6.11）：成員（含分課）與課程學員。預覽＝完整執行後復原；逐列結果；授權上限；權限；稽核。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
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
const SECRET = 'bulk-e2e-secret-bulk-e2e-secret-bulk';
const FINGERPRINT = 'sha256:e2e-bulk';
const ORG = 'f1f1f1f1-0000-0000-0000-00000000000a';
const U = {
  admin: 'f2f2f2f2-0000-0000-0000-00000000000a',
  instr: 'f2f2f2f2-0000-0000-0000-0000000000c1',
  cadmin: 'f2f2f2f2-0000-0000-0000-0000000000c2', // 課程管理員：可選課，不能新增組織成員
  member: 'f2f2f2f2-0000-0000-0000-0000000000d1', // 既有學員成員
  member2: 'f2f2f2f2-0000-0000-0000-0000000000d2',
  gone: 'f2f2f2f2-0000-0000-0000-0000000000d3', // 成員資格已停用
};

class CaptureMailer implements AccountMailer {
  readonly invites: string[] = [];
  async sendPasswordReset(): Promise<void> {}
  async sendInvitation(m: { to: string }): Promise<void> {
    this.invites.push(m.to);
  }
}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const mailer = new CaptureMailer();
const s = {} as Record<'admin' | 'cadmin', { token: string; csrf: string }>;
let courseId = '';
let courseCode = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: keyof typeof s | 'instrS', payload?: object) => {
  const t = who === 'instrS' ? instrS : s[who];
  return app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${t.token}; iac_csrf=${t.csrf}`, 'x-csrf-token': t.csrf } });
};
let instrS: { token: string; csrf: string };
const importMembers = (rows: object[], dryRun: boolean, who: keyof typeof s = 'admin') => call('POST', `/api/organizations/${ORG}/users/import`, who, { dryRun, rows });
const importLearners = (rows: object[], dryRun: boolean, who: keyof typeof s = 'admin') => call('POST', `/api/courses/${courseId}/enrollments/import`, who, { dryRun, rows });
const outcomes = (r: { rows: { line: number; outcome: string; issue?: string; actions: string[] }[] }) =>
  r.rows.map((x) => `${x.line} ${x.outcome}${x.issue ? ` ${x.issue}` : ''}${x.actions.length ? ` [${x.actions.join(',')}]` : ''}`);
const userCount = async () => (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`)).rows[0]!.n;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-b', 'Org Bulk', 'bk')`, [ORG]);
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [id, `${k}@bulk.test`, k]);
  const grant = (user: string, role: string, scope: string, scopeId: string | null) =>
    admin.query(`INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1, id, $3::scope_type, $4, $5 FROM roles WHERE code = $2`, [
      user,
      role,
      scope,
      scopeId,
      ORG,
    ]);
  await grant(U.admin, 'org_admin', 'organization', ORG);
  for (const k of ['instr', 'cadmin', 'member', 'member2', 'gone'] as const) await grant(U[k], 'learner', 'self', U[k]);
  await admin.query(`INSERT INTO disabled_memberships (organization_id, user_id) VALUES ($1, $2)`, [ORG, U.gone]);

  // 授權：最多 5 位進行中的學員
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-bulk', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{"max_active_learners": 5}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  s.admin = await session(U.admin);
  s.cadmin = await session(U.cadmin);
  instrS = await session(U.instr);

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

  // 一門已發布的課（講師編輯並發布）與一門草稿課
  const course = (await call('POST', '/api/courses', 'admin', { title: '匯入測試課' })).json();
  courseId = course.id;
  courseCode = course.code;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@bulk.test', role: 'instructor' });
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'cadmin@bulk.test', role: 'course_admin' });
  const v = (await call('POST', `/api/courses/${courseId}/versions`, 'instrS', { title: 'v1' })).json().id;
  const [M, L, A] = [randomUUID(), randomUUID(), randomUUID()];
  await call('PATCH', `/api/course-versions/${v}`, 'instrS', { modules: [{ id: M, title: '單元', lessons: [{ id: L, title: '課節', activities: [{ id: A, title: '閱讀', activityType: 'reading' }] }] }] });
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instrS', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instrS')).statusCode).toBe(200);
  await call('POST', '/api/courses', 'admin', { code: 'DRAFT-1', title: '還沒發布' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

const memberRows = () => [
  { email: 'New1@Bulk.test', displayName: '新生甲', role: 'learner', courseCode }, // 1 建帳號＋加入＋選課
  { email: 'member@bulk.test', courseCode }, // 2 既有成員選課
  { email: 'teacher-new@bulk.test', displayName: '新老師', role: 'instructor', courseCode }, // 3 建帳號＋指派講師
  { email: 'not-an-email', displayName: 'x' }, // 4
  { email: 'noname@bulk.test' }, // 5 新帳號沒填姓名
  { email: 'member2@bulk.test', courseCode: 'DRAFT-1' }, // 6 課程未發布
  { email: 'member2@bulk.test', role: 'instructor' }, // 7 講師沒填課程
  { email: 'new1@bulk.test', displayName: '新生甲', courseCode }, // 8 與第 1 列重複
  { email: 'gone@bulk.test', courseCode }, // 9 成員資格已停用
  { email: 'boss@bulk.test', displayName: 'Boss', role: 'boss' }, // 10 角色無法辨識
  { email: 'member2@bulk.test', courseCode: 'NOPE' }, // 11 課程代碼不存在
  { email: 'auditor-new@bulk.test', displayName: '稽核', role: 'auditor' }, // 12 組織層級角色
];
const EXPECTED = [
  '1 ok [account_created,member_added,enrolled]',
  '2 ok [enrolled]',
  '3 ok [account_created,member_added,course_role_granted]',
  '4 error invalid_email',
  '5 error name_required',
  '6 error course_not_published',
  '7 error course_required',
  '8 skipped duplicate_row',
  '9 error member_disabled',
  '10 error invalid_role',
  '11 error course_not_found',
  '12 ok [account_created,member_added]',
];

describe('member import (organization)', () => {
  it('preview runs the whole import and rolls back: per-row outcomes, nothing written, no invitations', async () => {
    const before = await userCount();
    const res = await importMembers(memberRows(), true);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ dryRun: true, batchId: null });
    expect(outcomes(r)).toEqual(EXPECTED);
    expect(r.summary).toMatchObject({ total: 12, ok: 4, skipped: 1, errors: 7, accountsCreated: 3, enrollments: 2, courseRoles: 1, invitationsSent: 0 });
    expect(await userCount()).toBe(before);
    expect((await admin.query(`SELECT 1 FROM enrollments`)).rowCount).toBe(0);
    expect(mailer.invites).toEqual([]);
  });

  it('import writes exactly what the preview showed, invites new accounts, and audits every row under one batch', async () => {
    const r = (await importMembers(memberRows(), false)).json();
    expect(outcomes(r)).toEqual(EXPECTED);
    expect(r.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.summary).toMatchObject({ accountsCreated: 3, invitationsSent: 3 });
    expect([...mailer.invites].sort()).toEqual(['auditor-new@bulk.test', 'new1@bulk.test', 'teacher-new@bulk.test']);

    const staff = await admin.query(`SELECT u.email FROM course_staff cs JOIN users u ON u.id = cs.user_id WHERE cs.course_id = $1 AND cs.staff_role = 'instructor' ORDER BY 1`, [courseId]);
    expect(staff.rows.map((x) => x.email)).toEqual(['instr@bulk.test', 'teacher-new@bulk.test']);
    const audits = await admin.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit_logs WHERE metadata->>'batch_id' = $1 GROUP BY action ORDER BY action`,
      [r.batchId],
    );
    expect(audits.rows).toEqual([
      { action: 'enrollment.assigned', n: 2 },
      { action: 'org.role.assigned', n: 1 },
      { action: 'org.user.created', n: 3 },
    ]);
  });

  it('importing the same file again is harmless: done rows are skipped', async () => {
    const r = (await importMembers(memberRows().slice(0, 3), false)).json();
    expect(outcomes(r)).toEqual(['1 skipped already_enrolled', '2 skipped already_enrolled', '3 skipped already_assigned']);
  });

  it('rows are limited to 500; learners cannot import', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ email: `x${i}@bulk.test`, displayName: 'x' }));
    expect((await importMembers(many, true)).statusCode).toBe(400);
    expect((await importMembers(memberRows(), true, 'cadmin')).statusCode).toBe(403);
  });
});

describe('learner import (course)', () => {
  it('an org admin enrolls existing members and creates accounts for new people', async () => {
    const r = (
      await importLearners(
        [
          { email: 'member2@bulk.test' },
          { email: 'fresh@bulk.test', displayName: '新同學' },
          { email: 'nameless@bulk.test' },
          { email: 'member@bulk.test' },
        ],
        false,
      )
    ).json();
    expect(outcomes(r)).toEqual([
      '1 ok [enrolled]',
      '2 ok [account_created,member_added,enrolled]',
      '3 error name_required',
      '4 skipped already_enrolled',
    ]);
  });

  it('a course admin can enroll members but cannot create accounts', async () => {
    const r = (await importLearners([{ email: 'another@bulk.test', displayName: '別人' }], true, 'cadmin')).json();
    expect(outcomes(r)).toEqual(['1 error not_in_organization']);
  });
});

describe('license limit (max 5 active learners)', () => {
  it('preview reports the overflow; the import is refused as a whole', async () => {
    // 目前進行中：new1、member、member2、fresh = 4
    const rows = [
      { email: 'late1@bulk.test', displayName: '晚到一' },
      { email: 'late2@bulk.test', displayName: '晚到二' },
    ];
    const preview = (await importLearners(rows, true)).json();
    expect(preview.license).toEqual({ maxActiveLearners: 5, activeLearnersAfter: 6, exceededBy: 1 });
    const res = await importLearners(rows, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_LIMIT_EXCEEDED');
    expect((await admin.query(`SELECT 1 FROM users WHERE email IN ('late1@bulk.test', 'late2@bulk.test')`)).rowCount).toBe(0);
  });
});

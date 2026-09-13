/**
 * 班級（梯次）與學號（Phase 2-5，SA v1.21、SD §6.15）：班級管理、成員資料、批次匯入更新既有成員（不重寄邀請）、
 * 整班加入、選課時的班級快照、每年更新。
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
const SECRET = 'cohort-e2e-secret-cohort-e2e-secret';
const FINGERPRINT = 'sha256:e2e-cohort';
const ORG = 'b1b1b1b1-0000-0000-0000-00000000000a';
const U = {
  admin: 'b2b2b2b2-0000-0000-0000-00000000000a',
  instr: 'b2b2b2b2-0000-0000-0000-0000000000c1',
  cadmin: 'b2b2b2b2-0000-0000-0000-0000000000c2',
  s1: 'b2b2b2b2-0000-0000-0000-0000000000d1',
  s2: 'b2b2b2b2-0000-0000-0000-0000000000d2',
  s3: 'b2b2b2b2-0000-0000-0000-0000000000d3',
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
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let courseId = '';
let c1 = '';
let c2 = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf } });
const importMembers = (rows: object[], dryRun: boolean, createMissingCohorts = false) =>
  call('POST', `/api/organizations/${ORG}/users/import`, 'admin', { dryRun, createMissingCohorts, rows });
const outcomes = (r: { rows: { line: number; outcome: string; issue?: string; actions: string[] }[] }) =>
  r.rows.map((x) => `${x.line} ${x.outcome}${x.issue ? ` ${x.issue}` : ''}${x.actions.length ? ` [${x.actions.join(',')}]` : ''}`);
const ids = (list: { id: string }[]) => list.map((x) => x.id);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-co', 'Org Cohort', 'co')`, [ORG]);
  for (const [k, id] of Object.entries(U)) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [id, `${k}@co.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'cadmin', 's1', 's2', 's3'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-co', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) s[k] = await session(U[k]);

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

  courseId = (await call('POST', '/api/courses', 'admin', { title: '班級測試課' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@co.test', role: 'instructor' });
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'cadmin@co.test', role: 'course_admin' });
  const v = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  await call('PATCH', `/api/course-versions/${v}`, 'instr', {
    modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: randomUUID(), title: '閱讀', activityType: 'reading' }] }] }],
  });
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instr')).statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('cohorts', () => {
  it('org admins create cohorts; active names are unique; teachers cannot manage them', async () => {
    const r = await call('POST', `/api/organizations/${ORG}/cohorts`, 'admin', { name: '113 三年二班', term: '113 學年' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: '113 三年二班', term: '113 學年', status: 'active', memberCount: 0 });
    c1 = r.json().id;
    const dup = await call('POST', `/api/organizations/${ORG}/cohorts`, 'admin', { name: '113 三年二班' });
    expect(dup.json().error.details[0]).toMatchObject({ field: 'name', issue: 'already_exists' });
    expect((await call('POST', `/api/organizations/${ORG}/cohorts`, 'instr', { name: '偷建' })).statusCode).toBe(403);
    expect(ids((await call('GET', `/api/organizations/${ORG}/cohorts`, 'admin')).json())).toEqual([c1]);
  });
});

describe('member profile', () => {
  it('sets the member number and cohorts; numbers are unique within the organization', async () => {
    const r = await call('PATCH', `/api/organizations/${ORG}/users/${U.s1}/profile`, 'admin', { memberNo: 'S001', cohortIds: [c1] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ memberNo: 'S001', cohorts: [{ id: c1, name: '113 三年二班' }] });
    const taken = await call('PATCH', `/api/organizations/${ORG}/users/${U.s2}/profile`, 'admin', { memberNo: 'S001' });
    expect(taken.json().error.details[0]).toMatchObject({ issue: 'member_no_taken' });

    const byCohort = (await call('GET', `/api/organizations/${ORG}/users?cohortId=${c1}`, 'admin')).json().data;
    expect(ids(byCohort)).toEqual([U.s1]);
    expect(byCohort[0]).toMatchObject({ memberNo: 'S001', cohorts: [{ id: c1, name: '113 三年二班' }] });
    expect(ids((await call('GET', `/api/organizations/${ORG}/users?q=s001`, 'admin')).json().data)).toEqual([U.s1]);
    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'org.member.updated'`)).rowCount).toBe(1);
  });
});

describe('bulk import with member numbers and cohorts', () => {
  const rows = [
    { email: 's2@co.test', memberNo: 'S002', cohort: '113 三年二班' },
    { email: 's3@co.test', memberNo: 'S003', cohort: '114 四年一班' },
    { email: 's1@co.test', memberNo: 'S002' },
  ];

  it('an unknown cohort is an error for that row unless auto-create is on; duplicate numbers are caught', async () => {
    const r = (await importMembers(rows, true)).json();
    expect(outcomes(r)).toEqual(['1 ok [profile_updated,cohort_joined]', '2 error cohort_not_found', '3 error member_no_taken']);
  });

  it('existing members get their number and class without a new invitation; missing cohorts can be created', async () => {
    const r = (await importMembers(rows.slice(0, 2), false, true)).json();
    expect(outcomes(r)).toEqual(['1 ok [profile_updated,cohort_joined]', '2 ok [profile_updated,cohort_created,cohort_joined]']);
    expect(r.summary).toMatchObject({ profilesUpdated: 2, cohortJoins: 2, cohortsCreated: 1, invitationsSent: 0, membersAdded: 0 });
    expect(mailer.invites).toEqual([]);
    c2 = (await call('GET', `/api/organizations/${ORG}/cohorts`, 'admin')).json().find((c: { name: string }) => c.name === '114 四年一班').id;
    // 再匯入一次：沒有變更
    expect(outcomes((await importMembers(rows.slice(0, 2), true)).json())).toEqual(['1 skipped already_member', '2 skipped already_member']);
  });
});

describe('enrolling a whole cohort', () => {
  it('course admins see the organization cohorts and enroll a whole class after a preview', async () => {
    const opts = (await call('GET', `/api/courses/${courseId}/cohorts`, 'cadmin')).json();
    expect(opts.find((c: { id: string }) => c.id === c1)).toMatchObject({ name: '113 三年二班', memberCount: 2 });
    expect((await call('GET', `/api/courses/${courseId}/cohorts`, 'instr')).statusCode).toBe(403);

    const pre = (await call('POST', `/api/courses/${courseId}/enrollments/cohort`, 'cadmin', { dryRun: true, cohortId: c1 })).json();
    expect(outcomes(pre)).toEqual(['1 ok [enrolled]', '2 ok [enrolled]']);
    expect((await admin.query(`SELECT 1 FROM enrollments`)).rowCount).toBe(0);
    const done = (await call('POST', `/api/courses/${courseId}/enrollments/cohort`, 'cadmin', { dryRun: false, cohortId: c1 })).json();
    expect(done.summary.enrollments).toBe(2);
  });

  it('the learner list shows member numbers and the class at enrollment time, and filters by them', async () => {
    const page = (await call('GET', `/api/courses/${courseId}/learners`, 'cadmin')).json();
    expect(page.meta.cohorts).toEqual(['113 三年二班']);
    expect(page.data.map((l: { memberNo: string; cohortLabel: string }) => [l.memberNo, l.cohortLabel])).toEqual([
      ['S001', '113 三年二班'],
      ['S002', '113 三年二班'],
    ]);
    expect((await call('GET', `/api/courses/${courseId}/learners?q=S002`, 'cadmin')).json().data.map((l: { memberNo: string }) => l.memberNo)).toEqual(['S002']);
    expect((await call('GET', `/api/courses/${courseId}/learners?cohort=${encodeURIComponent('113 三年二班')}`, 'cadmin')).json().data).toHaveLength(2);
    expect((await call('GET', `/api/courses/${courseId}/learners?cohort=${encodeURIComponent('別班')}`, 'cadmin')).json().data).toHaveLength(0);
  });

  it('next school year: archive the old class and move the learner; past enrollments keep the old class', async () => {
    expect((await call('POST', `/api/organizations/${ORG}/cohorts/${c1}/archive`, 'admin')).json().status).toBe('archived');
    await call('PATCH', `/api/organizations/${ORG}/users/${U.s1}/profile`, 'admin', { cohortIds: [c2] });
    const m = (await call('GET', `/api/organizations/${ORG}/users?q=S001`, 'admin')).json().data[0];
    expect(m.cohorts).toEqual([{ id: c2, name: '114 四年一班' }]);

    const l = (await call('GET', `/api/courses/${courseId}/learners?q=S001`, 'cadmin')).json().data[0];
    expect(l.cohortLabel).toBe('113 三年二班');
    const p = (await call('GET', `/api/enrollments/${l.id}/progress`, 'cadmin')).json();
    expect(p.learner).toMatchObject({ memberNo: 'S001', cohortLabel: '113 三年二班' });

    // 封存的班級不能整班加入；同名的新班級可以建立，這時恢復舊的會衝突
    const archived = await call('POST', `/api/courses/${courseId}/enrollments/cohort`, 'cadmin', { dryRun: true, cohortId: c1 });
    expect(archived.json().error.details[0]).toMatchObject({ issue: 'cohort_not_found' });
    expect((await call('POST', `/api/organizations/${ORG}/cohorts`, 'admin', { name: '113 三年二班' })).statusCode).toBe(201);
    expect((await call('POST', `/api/organizations/${ORG}/cohorts/${c1}/restore`, 'admin')).json().error.details[0]).toMatchObject({ issue: 'already_exists' });
    expect(ids((await call('GET', `/api/organizations/${ORG}/cohorts?status=archived`, 'admin')).json())).toEqual([c1]);
  });
});

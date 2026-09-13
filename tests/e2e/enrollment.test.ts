/**
 * 選課（Phase 2-1，SA §7.2、UC-ENR-001/005/006/010、SD §6.8）。
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
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'enroll-e2e-secret-enroll-e2e-secret';
const FINGERPRINT = 'sha256:e2e-enroll';
const ORG = 'bcbcbcbc-0000-0000-0000-00000000000a';
const OTHER_ORG = 'bcbcbcbc-0000-0000-0000-00000000000b';
const U = {
  admin: 'cdcdcdcd-0000-0000-0000-00000000000a',
  instr: 'cdcdcdcd-0000-0000-0000-0000000000c1',
  l1: 'cdcdcdcd-0000-0000-0000-0000000000d1',
  aud: 'cdcdcdcd-0000-0000-0000-0000000000d2', // 只有稽核人員角色
  l3: 'cdcdcdcd-0000-0000-0000-0000000000d3',
  l4: 'cdcdcdcd-0000-0000-0000-0000000000d4',
  outsider: 'cdcdcdcd-0000-0000-0000-0000000000e1',
};
const EMAIL: Record<keyof typeof U, string> = {
  admin: 'admin@enr.test',
  instr: 'instr@enr.test',
  l1: 'l1@enr.test',
  aud: 'aud@enr.test',
  l3: 'l3@enr.test',
  l4: 'l4@enr.test',
  outsider: 'outsider@enr.test',
};

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let courseId = '';
let publishedVersionId = '';
let l1Enrollment = '';

async function session(userId: string, org: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: keyof typeof U, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf },
  });
const enroll = (who: keyof typeof U, as: keyof typeof U = 'admin', course = courseId) => call('POST', `/api/courses/${course}/enrollments`, as, { email: EMAIL[who] });
const lastAudit = async (action: string) =>
  (await admin.query(`SELECT resource_id, before_state, after_state, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-e', 'Org E', 'e'), ($2, 'org-f', 'Org F', 'f')`, [ORG, OTHER_ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) {
    await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], EMAIL[k], k]);
  }
  const grant = (user: string, role: string, scope: string, scopeId: string | null, org: string) =>
    admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
       SELECT $1, id, $3::scope_type, $4, $5 FROM roles WHERE code = $2`,
      [user, role, scope, scopeId, org],
    );
  await grant(U.admin, 'org_admin', 'organization', ORG, ORG);
  for (const k of ['instr', 'l1', 'l3', 'l4'] as const) await grant(U[k], 'learner', 'self', U[k], ORG);
  await grant(U.aud, 'auditor', 'organization', ORG, ORG);
  await grant(U.outsider, 'learner', 'self', U.outsider, OTHER_ORG);

  // 授權：最多 3 位進行中的學員
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-enr', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{"max_active_learners": 3}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) s[k] = await session(U[k], k === 'outsider' ? OTHER_ORG : ORG);

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
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // 建立並發布一門課：講師編輯、設定完成條件、發布
  courseId = (await call('POST', '/api/courses', 'admin', { title: '選課測試課' })).json().id;
  expect((await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: EMAIL.instr, role: 'instructor' })).statusCode).toBe(201);
  publishedVersionId = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  const [M, L, A] = [randomUUID(), randomUUID(), randomUUID()];
  await call('PATCH', `/api/course-versions/${publishedVersionId}`, 'instr', {
    modules: [{ id: M, title: '單元', lessons: [{ id: L, title: '課節', activities: [{ id: A, title: '閱讀', activityType: 'reading' }] }] }],
  });
  await call('PUT', `/api/course-versions/${publishedVersionId}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${publishedVersionId}/publish`, 'instr')).statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('assigning learners (UC-ENR-001)', () => {
  it('a course without a published version cannot take learners', async () => {
    const draftCourse = (await call('POST', '/api/courses', 'admin', { title: '還沒發布' })).json().id;
    expect((await enroll('l1', 'admin', draftCourse)).json().error.details).toEqual([{ issue: 'course_not_published' }]);
  });

  it('assigns an org member; the enrollment is bound to the published version; audit records it', async () => {
    const res = await enroll('l1');
    expect(res.statusCode).toBe(201);
    const e = res.json();
    l1Enrollment = e.id;
    expect(e).toMatchObject({ courseId, courseVersionId: publishedVersionId, versionNo: 1, userId: U.l1, status: 'active', enrollMethod: 'assign' });
    expect(await lastAudit('enrollment.assigned')).toMatchObject({ resource_id: e.id, after_state: { userId: U.l1, status: 'active' }, metadata: { learner_role_granted: false } });
  });

  it('refuses duplicates and non-members; instructors cannot assign', async () => {
    expect((await enroll('l1')).json().error.details).toEqual([{ field: 'email', issue: 'already_enrolled' }]);
    expect((await enroll('outsider')).json().error.details).toEqual([{ field: 'email', issue: 'not_in_organization' }]);
    expect((await enroll('l3', 'instr')).statusCode).toBe(403);
  });

  it('assigning a member without the learner role grants it, so they can actually learn', async () => {
    expect((await enroll('aud')).statusCode).toBe(201);
    expect((await lastAudit('enrollment.assigned')).metadata).toEqual({ learner_role_granted: true });
    const roles = await admin.query(`SELECT r.code FROM user_org_roles uor JOIN roles r ON r.id = uor.role_id WHERE uor.user_id = $1 ORDER BY r.code`, [U.aud]);
    expect(roles.rows.map((x) => x.code)).toEqual(['auditor', 'learner']);
  });
});

describe('who sees what', () => {
  it('learners see only their own enrollments (UC-ENR-010)', async () => {
    const mine = (await call('GET', '/api/me/enrollments', 'l1')).json();
    expect(mine).toEqual([expect.objectContaining({ id: l1Enrollment, course: expect.objectContaining({ title: '選課測試課' }), canLearn: true })]);
    expect((await call('GET', '/api/me/enrollments', 'l3')).json()).toEqual([]);
  });

  it('course staff list the learners; learners cannot', async () => {
    const byAdmin = (await call('GET', `/api/courses/${courseId}/learners`, 'admin')).json().data as { email: string }[];
    expect(byAdmin.map((l) => l.email)).toEqual([EMAIL.aud, EMAIL.l1]);
    expect((await call('GET', `/api/courses/${courseId}/learners?status=active`, 'instr')).statusCode).toBe(200);
    expect((await call('GET', `/api/courses/${courseId}/learners`, 'l1')).statusCode).toBe(403);
  });
});

describe('status changes (UC-ENR-005/006)', () => {
  const act = (action: string, id = l1Enrollment) => call('POST', `/api/enrollments/${id}/${action}`, 'admin');

  it('suspend → resume → withdraw, with audit; invalid transitions are refused', async () => {
    expect((await act('suspend')).json().status).toBe('suspended');
    expect((await act('suspend')).json().error.details).toEqual([{ issue: 'invalid_transition', params: { from: 'suspended' } }]);
    expect((await act('resume')).json().status).toBe('active');
    expect(await lastAudit('enrollment.resumed')).toMatchObject({ before_state: { status: 'suspended' }, after_state: { status: 'active' } });
    const w = (await act('withdraw')).json();
    expect(w).toMatchObject({ status: 'withdrawn' });
    expect(w.withdrawnAt).not.toBeNull();
    expect((await call('GET', '/api/me/enrollments', 'l1')).json()[0]).toMatchObject({ status: 'withdrawn', canLearn: false });
  });

  it('a withdrawn learner can be assigned again (a new enrollment)', async () => {
    const again = await enroll('l1');
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(l1Enrollment);
  });

  it('staff of another organization cannot touch the enrollment (404)', async () => {
    expect((await call('POST', `/api/enrollments/${l1Enrollment}/suspend`, 'outsider')).statusCode).toBe(404);
  });
});

describe('license limit (maxActiveLearners = 3)', () => {
  it('counts active / suspended / reopened learners; the fourth is refused', async () => {
    expect((await enroll('l3')).statusCode).toBe(201); // l1、aud、l3
    const res = await enroll('l4');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_LIMIT_EXCEEDED');
  });
});

/**
 * 選課碼、課程目錄、審核與學員名單匯出（SA UC-ENR-002／003／004、SD §6.24）。
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
const SECRET = 'enrcode-e2e-secret-enrcode-e2e-secret';
const FINGERPRINT = 'sha256:e2e-enrcode';
const ORG = 'e1e1e1e1-0000-0000-0000-00000000000a';
const OTHER_ORG = 'e1e1e1e1-0000-0000-0000-00000000000b';
const U = {
  admin: 'e2e2e2e2-0000-0000-0000-00000000000a',
  instr: 'e2e2e2e2-0000-0000-0000-0000000000c1',
  l1: 'e2e2e2e2-0000-0000-0000-0000000000d1',
  l2: 'e2e2e2e2-0000-0000-0000-0000000000d2',
  l3: 'e2e2e2e2-0000-0000-0000-0000000000d3',
  l4: 'e2e2e2e2-0000-0000-0000-0000000000d4',
  outsider: 'e2e2e2e2-0000-0000-0000-0000000000e1',
};
type Who = keyof typeof U;
const EMAIL = (k: Who) => `${k}@enrcode.test`;
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<Who, { token: string; csrf: string }>;
let codeCourse = '';
let catalogCourse = '';
let code = '';

async function session(userId: string, org: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), org],
  );
  return { token, csrf: csrfTokenFor(r.rows[0]!.id, SECRET) };
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: Who, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload && { payload }),
    headers: { cookie: `iac_session=${s[who].token}; iac_csrf=${s[who].csrf}`, 'x-csrf-token': s[who].csrf },
  });
const setPolicy = (course: string, body: object) => call('PUT', `/api/courses/${course}/enrollment-policy`, 'admin', body);
const joinCode = (who: Who, c: string) => call('POST', '/api/me/enrollments/join', who, { code: c });
const issues = (r: { json(): { error?: { details?: unknown } } }) => r.json().error?.details;
const lastAudit = async (action: string) =>
  (await admin.query(`SELECT resource_id, before_state, after_state, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];
const enrolledEvents = async (enrollmentId: string) =>
  (await admin.query(`SELECT 1 FROM learning_events WHERE enrollment_id = $1 AND event_type = 'course.enrolled'`, [enrollmentId])).rowCount;

async function publishedCourse(title: string): Promise<string> {
  // 版本由講師編輯與發布（組織管理員沒有編輯權限）
  const id = (await call('POST', '/api/courses', 'admin', { title })).json().id as string;
  expect((await call('POST', `/api/courses/${id}/staff`, 'admin', { email: EMAIL('instr'), role: 'instructor' })).statusCode).toBe(201);
  const v = (await call('POST', `/api/courses/${id}/versions`, 'instr', { title: 'v1' })).json().id as string;
  const [M, L, A] = [randomUUID(), randomUUID(), randomUUID()];
  await call('PATCH', `/api/course-versions/${v}`, 'instr', {
    modules: [{ id: M, title: '單元', lessons: [{ id: L, title: '課節', activities: [{ id: A, title: '閱讀', activityType: 'reading' }] }] }],
  });
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instr')).statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-c', 'Org C', 'c'), ($2, 'org-d', 'Org D', 'd')`, [ORG, OTHER_ORG]);
  for (const k of Object.keys(U) as Who[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], EMAIL(k), k]);
  const grant = (user: string, role: string, scope: string, scopeId: string | null, org: string) =>
    admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id)
       SELECT $1, id, $3::scope_type, $4, $5 FROM roles WHERE code = $2`,
      [user, role, scope, scopeId, org],
    );
  await grant(U.admin, 'org_admin', 'organization', ORG, ORG);
  for (const k of ['instr', 'l1', 'l2', 'l3', 'l4'] as const) await grant(U[k], 'learner', 'self', U[k], ORG);
  await grant(U.outsider, 'learner', 'self', U.outsider, OTHER_ORG);

  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-enrcode', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{"max_active_learners": 20}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as Who[]) s[k] = await session(U[k], k === 'outsider' ? OTHER_ORG : ORG);

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

  codeCourse = await publishedCourse('選課碼測試課');
  catalogCourse = await publishedCourse('目錄測試課');
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('enrollment policy', () => {
  it('defaults to "assigned by admins only"', async () => {
    const r = await call('GET', `/api/courses/${codeCourse}/enrollment-policy`, 'admin');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ joinBy: 'assign', requireApproval: false, code: null, maxSeats: null, seatsUsed: 0, pending: 0 });
  });

  it('learners and instructors cannot read or change it', async () => {
    expect((await call('GET', `/api/courses/${codeCourse}/enrollment-policy`, 'l1')).statusCode).toBe(403);
    expect((await call('PUT', `/api/courses/${codeCourse}/enrollment-policy`, 'instr', { joinBy: 'code' })).statusCode).toBe(403);
  });

  it('code mode generates an 8-character code without look-alike characters, and audits it', async () => {
    const r = await setPolicy(codeCourse, { joinBy: 'code' });
    expect(r.statusCode).toBe(200);
    code = r.json().code;
    expect(code).toMatch(CODE_RE);
    const a = await lastAudit('course.enrollment_policy.updated');
    expect(a.resource_id).toBe(codeCourse);
    expect(a.before_state).toMatchObject({ joinBy: 'assign', code: null });
    expect(a.after_state).toMatchObject({ joinBy: 'code', code });
  });

  it('the window must close after it opens', async () => {
    const r = await setPolicy(codeCourse, { joinBy: 'code', opensAt: '2026-10-01T00:00:00Z', closesAt: '2026-09-01T00:00:00Z' });
    expect(issues(r)).toEqual([{ field: 'closesAt', issue: 'must_be_after_opens' }]);
  });
});

describe('joining by code (UC-ENR-003)', () => {
  it('normalises the code, enrols as active on the published version, and records the start of the learning history', async () => {
    const r = await joinCode('l1', ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ courseId: codeCourse, courseTitle: '選課碼測試課', status: 'active', alreadyEnrolled: false });
    const e = (await admin.query(`SELECT enroll_method, assigned_by FROM enrollments WHERE id = $1`, [r.json().enrollmentId])).rows[0];
    expect(e).toEqual({ enroll_method: 'code', assigned_by: null });
    expect(await enrolledEvents(r.json().enrollmentId)).toBe(1);
    expect((await lastAudit('enrollment.joined')).metadata).toMatchObject({ via: 'code', already_enrolled: false });
  });

  it('joining again returns the existing enrolment', async () => {
    const r = await joinCode('l1', code);
    expect(r.json()).toMatchObject({ status: 'active', alreadyEnrolled: true });
    expect((await admin.query(`SELECT count(*)::int AS n FROM enrollments WHERE course_id = $1 AND user_id = $2`, [codeCourse, U.l1])).rows[0].n).toBe(1);
  });

  it('an unknown code, or the right code from another organisation, does not reveal the course', async () => {
    expect(issues(await joinCode('l2', 'ZZZZ2222'))).toEqual([{ field: 'code', issue: 'code_not_found' }]);
    expect(issues(await joinCode('outsider', code))).toEqual([{ field: 'code', issue: 'code_not_found' }]);
  });

  it('regenerating the code invalidates the old one immediately', async () => {
    const old = code;
    code = (await setPolicy(codeCourse, { joinBy: 'code', regenerateCode: true })).json().code;
    expect(code).toMatch(CODE_RE);
    expect(code).not.toBe(old);
    expect(issues(await joinCode('l2', old))).toEqual([{ field: 'code', issue: 'code_not_found' }]);
  });
});

describe('approval (UC-ENR-004)', () => {
  let l2Enrollment = '';

  it('a course that requires approval creates a pending request without learning events', async () => {
    const policy = (await setPolicy(codeCourse, { joinBy: 'code', requireApproval: true })).json();
    expect(policy.code).toBe(code); // 沒要求重新產生就沿用
    const r = await joinCode('l2', code);
    expect(r.json()).toMatchObject({ status: 'pending', alreadyEnrolled: false });
    l2Enrollment = r.json().enrollmentId;
    expect((await admin.query(`SELECT enroll_method FROM enrollments WHERE id = $1`, [l2Enrollment])).rows[0].enroll_method).toBe('approval');
    expect(await enrolledEvents(l2Enrollment)).toBe(0);
    const mine = (await call('GET', '/api/me/enrollments', 'l2')).json() as { id: string; status: string; canLearn: boolean }[];
    expect(mine.find((e) => e.id === l2Enrollment)).toMatchObject({ status: 'pending', canLearn: false });
    expect((await call('GET', `/api/courses/${codeCourse}/enrollment-policy`, 'admin')).json()).toMatchObject({ pending: 1, seatsUsed: 2 });
  });

  it('instructors cannot approve; admins can, and learning starts at that point', async () => {
    expect((await call('POST', `/api/enrollments/${l2Enrollment}/approve`, 'instr')).statusCode).toBe(403);
    const r = await call('POST', `/api/enrollments/${l2Enrollment}/approve`, 'admin');
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('active');
    expect(await enrolledEvents(l2Enrollment)).toBe(1);
    expect((await admin.query(`SELECT assigned_by FROM enrollments WHERE id = $1`, [l2Enrollment])).rows[0].assigned_by).toBe(U.admin);
    expect((await lastAudit('enrollment.approved')).after_state).toMatchObject({ status: 'active' });
  });

  it('only pending requests can be approved', async () => {
    expect(issues(await call('POST', `/api/enrollments/${l2Enrollment}/approve`, 'admin'))).toEqual([{ issue: 'invalid_transition', params: { from: 'active' } }]);
  });

  it('a rejected learner can ask again', async () => {
    const first = (await joinCode('l3', code)).json().enrollmentId;
    const r = await call('POST', `/api/enrollments/${first}/reject`, 'admin', { reason: '非本班學生' });
    expect(r.json().status).toBe('rejected');
    expect((await lastAudit('enrollment.rejected')).metadata).toMatchObject({ reason: '非本班學生' });
    const again = await joinCode('l3', code);
    expect(again.json()).toMatchObject({ status: 'pending', alreadyEnrolled: false });
    expect(again.json().enrollmentId).not.toBe(first);
  });
});

describe('window and seats', () => {
  it('seats limit self-enrolment (pending requests included), but not admins', async () => {
    // 已占用：l1、l2（學習中）、l3（待審核）
    await setPolicy(codeCourse, { joinBy: 'code', maxSeats: 3 });
    expect(issues(await joinCode('l4', code))).toEqual([{ issue: 'course_full' }]);
    expect((await call('POST', `/api/courses/${codeCourse}/enrollments`, 'admin', { email: EMAIL('l4') })).statusCode).toBe(201);
  });

  it('outside the window nobody can join', async () => {
    await setPolicy(catalogCourse, { joinBy: 'code', opensAt: '2020-01-01T00:00:00Z', closesAt: '2020-02-01T00:00:00Z' });
    const c = (await call('GET', `/api/courses/${catalogCourse}/enrollment-policy`, 'admin')).json().code;
    expect(issues(await joinCode('l1', c))).toEqual([{ issue: 'enrollment_closed', params: { opensAt: '2020-01-01T00:00:00Z', closesAt: '2020-02-01T00:00:00Z' } }]);
  });
});

describe('catalog (UC-ENR-002)', () => {
  it('lists open catalog courses of the current organisation only', async () => {
    await setPolicy(catalogCourse, { joinBy: 'catalog' });
    const list = (await call('GET', '/api/me/catalog', 'l1')).json() as { id: string; availability: string; myEnrollment: unknown }[];
    expect(list.map((c) => c.id)).toEqual([catalogCourse]);
    expect(list[0]).toMatchObject({ availability: 'open', myEnrollment: null, requireApproval: false });
    expect((await call('GET', '/api/me/catalog', 'outsider')).json()).toEqual([]);
  });

  it('joins from the catalog; code courses and other organisations are 404', async () => {
    const r = await call('POST', `/api/courses/${catalogCourse}/join`, 'l1');
    expect(r.json()).toMatchObject({ status: 'active', alreadyEnrolled: false });
    expect((await admin.query(`SELECT enroll_method FROM enrollments WHERE id = $1`, [r.json().enrollmentId])).rows[0].enroll_method).toBe('self');
    expect((await call('POST', `/api/courses/${codeCourse}/join`, 'l2')).statusCode).toBe(404);
    expect((await call('POST', `/api/courses/${catalogCourse}/join`, 'outsider')).statusCode).toBe(404);
    const list = (await call('GET', '/api/me/catalog', 'l1')).json();
    expect(list[0].myEnrollment).toMatchObject({ status: 'active' });
  });

  it('switching away from code mode clears the code', async () => {
    const p = (await call('GET', `/api/courses/${catalogCourse}/enrollment-policy`, 'admin')).json();
    expect(p).toMatchObject({ joinBy: 'catalog', code: null });
  });
});

describe('learner export', () => {
  it('exports a CSV Excel can open, with per-activity columns, and audits it', async () => {
    const r = await call('GET', `/api/courses/${codeCourse}/learners/export`, 'instr');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="learners-[\w.-]+-\d{8}\.csv"$/);
    // 每個儲存格都加引號（common/csv.ts）；BOM 讓 Excel 以 UTF-8 開啟
    expect(r.body.startsWith('﻿"學號","姓名","Email","班級（選課時）","狀態","加入方式"')).toBe(true);
    const lines = r.body.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/,"閱讀"$/);
    // l1、l2、l3（被拒的那筆與再次申請的待審核）、l4——被拒的申請保留在名單中
    expect(lines).toHaveLength(1 + 5);
    expect(r.body).toContain(EMAIL('l1'));
    expect(r.body).toContain('選課碼');
    expect(r.body).toContain('申請審核');
    expect(r.body).toContain('未通過審核');
    expect((await lastAudit('course.learners.exported')).metadata).toMatchObject({ rows: 5, status: null });
  });

  it('applies the list filters', async () => {
    const r = await call('GET', `/api/courses/${codeCourse}/learners/export?status=pending`, 'admin');
    const lines = r.body.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(EMAIL('l3'));
    expect(lines[1]).toContain('待審核');
  });

  it('learners cannot export', async () => {
    expect((await call('GET', `/api/courses/${codeCourse}/learners/export`, 'l1')).statusCode).toBe(403);
  });
});

/**
 * 人工核可與證書（Phase 2-4，SA UC-CRT、SEQ-10/11、SD §6.14）：核可 → 完成 → 排入發證 → worker 發證 → 查詢、公開驗證、撤銷。
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { configureApp, createAdapter } from '../../apps/api/src/bootstrap.js';
import { csrfTokenFor } from '../../apps/api/src/common/csrf.js';
import { hashToken } from '../../apps/api/src/common/tokens.js';
import { ENV, loadEnv } from '../../apps/api/src/config/env.js';
import { Dispatcher } from '../../apps/worker/src/dispatcher.js';
import { CertificateGenerateHandler } from '../../apps/worker/src/handlers/certificate-generate.js';
import { NotificationEmailHandler } from '../../apps/worker/src/handlers/notification-email.js';
import { applyMigrations } from '../../tools/migrate.js';

const PW = { api_pw: 'e2e_api', coach_pw: 'e2e_coach', worker_pw: 'e2e_worker', ro_pw: 'e2e_ro' };
const SECRET = 'cert-e2e-secret-cert-e2e-secret-cert';
const FINGERPRINT = 'sha256:e2e-cert';
const ORG = 'c1c1c1c1-0000-0000-0000-00000000000a';
const U = {
  admin: 'c2c2c2c2-0000-0000-0000-00000000000a',
  instr: 'c2c2c2c2-0000-0000-0000-0000000000c1',
  cadmin: 'c2c2c2c2-0000-0000-0000-0000000000c2',
  me: 'c2c2c2c2-0000-0000-0000-0000000000d1',
  other: 'c2c2c2c2-0000-0000-0000-0000000000d2',
};
const READ = randomUUID();

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
let workerPool: pg.Pool;
let dispatcher: Dispatcher;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let courseId = '';
let myEnrollment = '';
let certId = '';
let code = '';

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
const approve = (who: keyof typeof U, body: object = {}) => call('POST', `/api/enrollments/${myEnrollment}/completion-approvals`, who, body);
const verify = (c: string) => app.inject({ method: 'GET', url: `/public/certificates/${c}` });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-c', '證書測試學苑', 'ct')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@cert.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'cadmin', 'me', 'other'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-cert', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
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
      }),
    )
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // worker 以自己的 DB 角色（app_worker）執行，與正式環境相同
  workerPool = new pg.Pool({ connectionString: `postgres://app_worker:${PW.worker_pw}@${h}:${p}/iac` });
  // output 佇列也有通知信的 job（SD §6.26）：不設 SMTP，寄信 job 只記 log
  dispatcher = new Dispatcher(workerPool, pino({ level: 'silent' }), { workerId: 'e2e', queues: ['output'] })
    .register(new CertificateGenerateHandler(workerPool))
    .register(new NotificationEmailHandler(workerPool, null, pino({ level: 'silent' }), 'https://learn.example.test'));

  // 課程：一個閱讀活動；完成條件＝完成必修活動 且 講師核可
  courseId = (await call('POST', '/api/courses', 'admin', { title: '安全實務' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@cert.test', role: 'instructor' });
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'cadmin@cert.test', role: 'course_admin' });
  const v = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  await call('PATCH', `/api/course-versions/${v}`, 'instr', {
    modules: [{ id: randomUUID(), title: '單元', lessons: [{ id: randomUUID(), title: '課節', activities: [{ id: READ, title: '閱讀', activityType: 'reading' }] }] }],
  });
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', {
    rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }, { type: 'manual_approval', approver_role: 'instructor' }] },
  });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instr')).statusCode).toBe(200);
  myEnrollment = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'me@cert.test' })).json().id;
  await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'other@cert.test' });
});

afterAll(async () => {
  await app?.close();
  await workerPool?.end();
  await admin?.end();
  await container?.stop();
});

describe('manual approval', () => {
  it('finishing the activities is not enough; staff see the approval is pending', async () => {
    const attempt = (await call('POST', `/api/activities/${READ}/attempts`, 'me')).json().attemptId;
    expect((await call('POST', `/api/attempts/${attempt}/submit`, 'me', { input: {} })).json()).toMatchObject({ status: 'completed', completionChanged: false });
    const o = (await call('GET', `/api/enrollments/${myEnrollment}/outline`, 'me')).json();
    expect(o.progress.blockingReasons.map((r: { code: string }) => r.code)).toContain('MANUAL_APPROVAL_PENDING');
    const p = (await call('GET', `/api/enrollments/${myEnrollment}/progress`, 'instr')).json();
    expect(p.approval).toEqual({ required: ['instructor'], given: [] });
    expect((await admin.query(`SELECT 1 FROM job_queue WHERE job_type = 'certificate.generate'`)).rowCount).toBe(0);
  });

  it('only someone holding the role named in the rule can approve', async () => {
    const byCourseAdmin = await approve('cadmin');
    expect(byCourseAdmin.statusCode).toBe(403);
    expect(byCourseAdmin.json().error.details[0]).toMatchObject({ issue: 'approver_role_required' });
    expect((await approve('admin')).statusCode).toBe(403);
    expect((await approve('me')).statusCode).toBe(403);
  });

  it('the instructor approves: the course completes and one certificate job is queued', async () => {
    const r = await approve('instr', { note: '實作表現良好' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ approvedRoles: ['instructor'], completionChanged: true });
    expect((await admin.query(`SELECT status FROM enrollments WHERE id = $1`, [myEnrollment])).rows[0].status).toBe('completed');
    const jobs = await admin.query(`SELECT job_type, queue, idempotency_key, status FROM job_queue WHERE job_type = 'certificate.generate'`);
    expect(jobs.rows).toEqual([{ job_type: 'certificate.generate', queue: 'output', idempotency_key: `cert:${myEnrollment}`, status: 'pending' }]);
    const audit = await admin.query(`SELECT metadata FROM audit_logs WHERE action = 'completion.approved'`);
    expect(audit.rows[0].metadata).toMatchObject({ note: '實作表現良好' });
    const p = (await call('GET', `/api/enrollments/${myEnrollment}/progress`, 'instr')).json();
    expect(p.approval.given).toMatchObject([{ approverRole: 'instructor', approverName: 'instr', note: '實作表現良好' }]);
    // 已完成的選課不能再核可
    expect((await approve('instr')).json().error.code).toBe('ENROLLMENT_NOT_ACTIVE');
  });
});

describe('issuing (worker)', () => {
  it('the worker issues exactly one certificate with a snapshot of the names, idempotently', async () => {
    expect(await dispatcher.tick()).toBe(true);
    expect((await admin.query(`SELECT status FROM job_queue WHERE idempotency_key = $1`, [`cert:${myEnrollment}`])).rows[0].status).toBe('succeeded');
    const certs = await admin.query(`SELECT id, status, learner_display_name, course_title, organization_name, verification_code FROM certificates WHERE enrollment_id = $1`, [myEnrollment]);
    expect(certs.rows).toHaveLength(1);
    expect(certs.rows[0]).toMatchObject({ status: 'valid', learner_display_name: 'me', course_title: '安全實務', organization_name: '證書測試學苑' });
    certId = certs.rows[0].id;
    code = certs.rows[0].verification_code;

    // 重複的工作（例如人為重跑）不會多發
    await admin.query(`INSERT INTO job_queue (job_type, queue, payload, idempotency_key) VALUES ('certificate.generate', 'output', $1, 'rerun-1')`, [{ enrollmentId: myEnrollment }]);
    // 連同通知信的 job 一起跑完
    while (await dispatcher.tick()) {
      /* 繼續取下一件 */
    }
    expect((await admin.query(`SELECT status FROM job_queue WHERE idempotency_key = 'rerun-1'`)).rows[0].status).toBe('succeeded');
    expect((await admin.query(`SELECT 1 FROM certificates WHERE enrollment_id = $1`, [myEnrollment])).rowCount).toBe(1);

    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE action = 'certificate.issued' AND resource_id = $1`, [certId])).rowCount).toBe(1);
    const t = (await call('GET', `/api/me/enrollments/${myEnrollment}/timeline?limit=100`, 'me')).json();
    expect(t.data.map((x: { eventType: string }) => x.eventType).slice(0, 3)).toEqual(['certificate.issued', 'course.completed', 'completion.approved']);
  });

  it('learners see only their own certificates, with the verification code', async () => {
    const mine = (await call('GET', '/api/me/certificates', 'me')).json();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: certId, status: 'valid', courseTitle: '安全實務', verificationCode: code, versionNo: 1 });
    expect((await call('GET', `/api/me/certificates/${certId}`, 'me')).statusCode).toBe(200);
    expect((await call('GET', `/api/me/certificates/${certId}`, 'other')).statusCode).toBe(404);
    expect((await call('GET', '/api/me/certificates', 'other')).json()).toEqual([]);
  });

  it('anyone can verify with the code, without logging in; nothing private is exposed', async () => {
    const r = await verify(code);
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(['courseTitle', 'issuedAt', 'learnerDisplayName', 'organizationName', 'publicId', 'status']);
    expect(r.json()).toMatchObject({ status: 'valid', learnerDisplayName: 'me', courseTitle: '安全實務' });
    expect(r.body).not.toContain('me@cert.test');
    expect(r.body).not.toContain(myEnrollment);
    expect((await verify('A'.repeat(32))).statusCode).toBe(404);
    expect((await verify('not-a-code')).statusCode).toBe(404);
  });

  it('course admins list the course certificates; instructors and learners cannot', async () => {
    const list = await call('GET', `/api/courses/${courseId}/certificates`, 'cadmin');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ id: certId, learnerEmail: 'me@cert.test' }]);
    expect(list.body).not.toContain(code);
    expect((await call('GET', `/api/courses/${courseId}/certificates`, 'instr')).statusCode).toBe(403);
    expect((await call('GET', `/api/courses/${courseId}/certificates`, 'me')).statusCode).toBe(403);
  });
});

describe('revoking', () => {
  it('needs certificate.revoke and a reason; keeps the record; verification shows revoked', async () => {
    expect((await call('POST', `/api/certificates/${certId}/revoke`, 'instr', { reason: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/api/certificates/${certId}/revoke`, 'cadmin', {})).statusCode).toBe(400);
    const r = await call('POST', `/api/certificates/${certId}/revoke`, 'cadmin', { reason: '資格不符' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'revoked', revokeReason: '資格不符' });

    const v = (await verify(code)).json();
    expect(v.status).toBe('revoked');
    expect(v.revokedAt).toBeTruthy();
    expect((await call('GET', '/api/me/certificates', 'me')).json()[0]).toMatchObject({ status: 'revoked', revokeReason: '資格不符' });

    const again = await call('POST', `/api/certificates/${certId}/revoke`, 'cadmin', { reason: '再一次' });
    expect(again.json().error.details[0]).toMatchObject({ issue: 'not_revocable' });
    expect((await admin.query(`SELECT metadata FROM audit_logs WHERE action = 'certificate.revoked'`)).rows[0].metadata).toMatchObject({ reason: '資格不符' });
    const t = (await call('GET', `/api/me/enrollments/${myEnrollment}/timeline`, 'me')).json();
    expect(t.data[0].eventType).toBe('certificate.revoked');
  });
});

describe('public verification rate limit', () => {
  it('30 requests per minute per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await verify(code)).statusCode);
    expect(codes).toContain(429);
  });
});

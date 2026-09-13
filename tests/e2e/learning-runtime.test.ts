/**
 * 學習 Runtime、作答、伺服器評分與完成判定（Phase 2-2a，SA SEQ-03、AC-LRN-001/003/005/007、SD §6.9）。
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
const SECRET = 'runtime-e2e-secret-runtime-e2e-secret';
const FINGERPRINT = 'sha256:e2e-runtime';
const ORG = 'dededede-0000-0000-0000-00000000000a';
const U = {
  admin: 'efefefef-0000-0000-0000-00000000000a',
  instr: 'efefefef-0000-0000-0000-0000000000c1',
  me: 'efefefef-0000-0000-0000-0000000000d1',
  other: 'efefefef-0000-0000-0000-0000000000d2',
  stranger: 'efefefef-0000-0000-0000-0000000000d3',
};
const ID = { M1: randomUUID(), M2: randomUUID(), L1: randomUUID(), L2: randomUUID(), READ: randomUUID(), QUIZ: randomUUID(), PARAM: randomUUID() };
const QUIZ_CONFIG = {
  questions: [
    { id: 'q1', prompt: '1+1=?', options: [{ id: 'a', label: '1' }, { id: 'b', label: '2' }] },
    { id: 'q2', prompt: '選出偶數', multiple: true, options: [{ id: 'x', label: '2' }, { id: 'y', label: '3' }, { id: 'z', label: '4' }] },
  ],
};
const QUIZ_KEY = { correct: { q1: ['b'], q2: ['x', 'z'] }, pass_threshold: 100 };

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<keyof typeof U, { token: string; csrf: string }>;
let myEnrollment = '';
let otherEnrollment = '';
let myQuizAttempt = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
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
const runtime = (activity: string, who: keyof typeof U = 'me') => call('GET', `/api/activities/${activity}/runtime`, who);
const start = (activity: string, who: keyof typeof U = 'me') => call('POST', `/api/activities/${activity}/attempts`, who);
const submit = (attempt: string, body: object, who: keyof typeof U = 'me') => call('POST', `/api/attempts/${attempt}/submit`, who, body);
const outline = (who: keyof typeof U = 'me', enrollment = myEnrollment) => call('GET', `/api/enrollments/${enrollment}/outline`, who);
const states = async () => {
  const o = (await outline()).json();
  return Object.fromEntries(o.modules.flatMap((m: { lessons: { activities: { id: string; state: string }[] }[] }) => m.lessons.flatMap((l) => l.activities.map((a) => [a.id, a.state]))));
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-r', 'Org R', 'rt')`, [ORG]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@rt.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'me', 'other', 'stranger'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-rt', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as (keyof typeof U)[]) s[k] = await session(U[k]);
  const defId = (await admin.query<{ id: string }>(`SELECT id FROM interactive_definitions WHERE component_type = 'native.ParameterControl'`)).rows[0]!.id;

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

  // 課程：單元一（閱讀 → 小考，小考以閱讀為先修）、單元二（參數實驗）；mixed：單元二要先完成單元一
  const courseId = (await call('POST', '/api/courses', 'admin', { title: 'Runtime 測試課' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@rt.test', role: 'instructor' });
  const v = (await call('POST', `/api/courses/${courseId}/versions`, 'instr', { title: 'v1' })).json().id;
  const patch = await call('PATCH', `/api/course-versions/${v}`, 'instr', {
    modules: [
      {
        id: ID.M1,
        title: '單元一',
        lessons: [
          {
            id: ID.L1,
            title: '課節一',
            contentBlocks: [{ type: 'richtext', markdown: '# 歡迎' }],
            activities: [
              { id: ID.READ, title: '閱讀', activityType: 'reading' },
              {
                id: ID.QUIZ,
                title: '小考',
                activityType: 'quiz',
                maxScore: 10,
                maxAttempts: 2,
                config: QUIZ_CONFIG,
                answerKey: QUIZ_KEY,
                prerequisite: { type: 'specific_activities_completed', activity_ids: [ID.READ] },
              },
            ],
          },
        ],
      },
      {
        id: ID.M2,
        title: '單元二',
        lessons: [
          {
            id: ID.L2,
            title: '課節二',
            activities: [
              {
                id: ID.PARAM,
                title: '參數實驗',
                activityType: 'interactive',
                interactiveDefinitionId: defId,
                config: { parameters: [{ id: 't', label: '溫度', min: 0, max: 100, step: 1 }] },
                answerKey: { acceptable_ranges: [{ parameter_id: 't', min: 40, max: 60, issue_code_if_high: 'TEMP_HIGH' }] },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(patch.statusCode).toBe(200);
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', {
    rule: { operator: 'AND', conditions: [{ type: 'required_activities_completed', value: true }, { type: 'minimum_score', value: 60 }] },
  });
  const pub = await call('POST', `/api/course-versions/${v}/publish`, 'instr');
  expect(pub.statusCode).toBe(200);
  myEnrollment = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'me@rt.test' })).json().id;
  otherEnrollment = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'other@rt.test' })).json().id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('outline and gating', () => {
  it('shows the structure, locks by prerequisite and by module order, and never leaks answers', async () => {
    const res = await outline();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enrollment).toMatchObject({ id: myEnrollment, canLearn: true, courseTitle: 'Runtime 測試課', versionNo: 1 });
    expect(body.progress).toMatchObject({ requiredTotal: 3, requiredCompleted: 0, completed: false });
    const acts = Object.fromEntries(
      body.modules.flatMap((m: { lessons: { activities: { id: string }[] }[] }) => m.lessons.flatMap((l) => l.activities.map((a) => [a.id, a]))),
    );
    expect(acts[ID.READ]).toMatchObject({ state: 'available', supported: true });
    expect(acts[ID.QUIZ]).toMatchObject({ state: 'locked', lockReason: 'prerequisite', maxAttempts: 2 });
    expect(acts[ID.PARAM]).toMatchObject({ state: 'locked', lockReason: 'sequence' });
    const raw = res.body;
    expect(raw).not.toContain('answerKey');
    expect(raw).not.toContain('acceptable_ranges');
    expect(raw).not.toContain('pass_threshold');
  });

  it('a locked activity refuses runtime and attempts with 403 ACTIVITY_PREREQUISITE_NOT_MET (AC-LRN-005)', async () => {
    expect((await runtime(ID.QUIZ)).json().error.code).toBe('ACTIVITY_PREREQUISITE_NOT_MET');
    expect((await start(ID.QUIZ)).statusCode).toBe(403);
  });

  it('other people cannot open my outline; people without an enrollment get 404', async () => {
    expect((await outline('other')).statusCode).toBe(404);
    expect((await runtime(ID.READ, 'stranger')).statusCode).toBe(404);
  });
});

describe('attempts and server-side scoring', () => {
  it('reading completes on submit', async () => {
    const rt = (await runtime(ID.READ)).json();
    expect(rt).toMatchObject({ componentType: 'builtin.reading', supported: true, attemptPolicy: { maxAttempts: null, usedAttempts: 0 }, previousResultSummary: null });
    const a = await start(ID.READ);
    expect(a.statusCode).toBe(201);
    expect(a.json().attemptNo).toBe(1);
    const r = await submit(a.json().attemptId, { input: {} });
    expect(r.json()).toMatchObject({ status: 'completed', score: null, completionChanged: false });
    expect((await states())[ID.QUIZ]).toBe('available');
  });

  it('the quiz runtime has questions but no answer key', async () => {
    const res = await runtime(ID.QUIZ);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ componentType: 'builtin.quiz', config: QUIZ_CONFIG, attemptPolicy: { maxAttempts: 2, usedAttempts: 0 } });
    expect(res.body).not.toContain('correct');
    expect(res.body).not.toContain('pass_threshold');
  });

  it('a submitted score or status is ignored; the server evaluator decides (AC-LRN-003)', async () => {
    myQuizAttempt = (await start(ID.QUIZ)).json().attemptId;
    const r = await submit(myQuizAttempt, { input: { answers: { q1: ['a'] } }, score: 100, status: 'passed' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'failed',
      score: 0,
      maxScore: 10,
      issues: [
        { code: 'WRONG_ANSWER', target: 'q1' },
        { code: 'UNANSWERED', target: 'q2' },
      ],
    });
    expect(JSON.stringify(r.json().feedbackData)).not.toContain('"b"');
    expect((await submit(myQuizAttempt, { input: { answers: {} } })).json().error.details).toEqual([{ issue: 'attempt_not_in_progress' }]);
  });

  it('invalid input is 422; the attempt stays open and can be resubmitted; attempts are capped', async () => {
    const second = (await start(ID.QUIZ)).json();
    expect(second.attemptNo).toBe(2);
    const bad = await submit(second.attemptId, { input: { answers: { q9: ['a'] } } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'ACTIVITY_INPUT_INVALID', details: [{ field: 'answers.q9', issue: 'UNKNOWN_QUESTION' }] });
    const good = await submit(second.attemptId, { input: { answers: { q1: ['b'], q2: ['z', 'x'] } } });
    expect(good.json()).toMatchObject({ status: 'passed', score: 10, issues: [], completionChanged: false });
    expect((await start(ID.QUIZ)).json().error.details).toEqual([{ issue: 'max_attempts_reached' }]);
  });

  it('only the owner can read an attempt result (AC-LRN-007)', async () => {
    expect((await call('GET', `/api/attempts/${myQuizAttempt}/result`, 'me')).json()).toMatchObject({ attemptNo: 1, status: 'failed' });
    expect((await call('GET', `/api/attempts/${myQuizAttempt}/result`, 'other')).statusCode).toBe(404);
  });
});

describe('completion (UC-ENR-008)', () => {
  it('the next module opens; finishing the last required activity completes the course', async () => {
    expect((await states())[ID.PARAM]).toBe('available');
    const first = (await start(ID.PARAM)).json().attemptId;
    const high = await submit(first, { input: { values: { t: 80 } } });
    expect(high.json()).toMatchObject({ status: 'needs_improvement', issues: [{ code: 'TEMP_HIGH', category: 'parameter', target: 't' }], completionChanged: false });

    const second = (await start(ID.PARAM)).json().attemptId;
    const ok = await submit(second, { input: { values: { t: 50 } } });
    expect(ok.json()).toMatchObject({ status: 'passed', score: 100, completionChanged: true });

    expect((await call('GET', '/api/me/enrollments', 'me')).json()[0]).toMatchObject({ id: myEnrollment, status: 'completed', canLearn: false });
    const snap = await admin.query(`SELECT required_total, required_completed, weighted_score FROM progress_snapshots WHERE enrollment_id = $1`, [myEnrollment]);
    expect(snap.rows[0]).toMatchObject({ required_total: 3, required_completed: 3, weighted_score: '100.00' });
    // 已完成的選課不能再作答
    expect((await start(ID.READ)).json().error.code).toBe('ENROLLMENT_NOT_ACTIVE');
  });

  it('course staff can inspect a learner’s completion with the trace; learners cannot', async () => {
    const r = await call('GET', `/api/enrollments/${myEnrollment}/completion`, 'admin');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: true, value: 'TRUE', requiredCompleted: 3, weightedScore: 100 });
    expect(r.json().trace.map((t: { type: string }) => t.type)).toEqual(['required_activities_completed', 'minimum_score', 'AND']);
    const other = (await call('GET', `/api/enrollments/${otherEnrollment}/completion`, 'admin')).json();
    expect(other.blockingReasons[0]).toMatchObject({ code: 'REQUIRED_ACTIVITIES_INCOMPLETE', actual: 0, required: 3 });
    expect((await call('GET', `/api/enrollments/${myEnrollment}/completion`, 'me')).statusCode).toBe(403);
  });

  it('a suspended enrollment cannot learn (409 ENROLLMENT_NOT_ACTIVE)', async () => {
    await call('POST', `/api/enrollments/${otherEnrollment}/suspend`, 'admin');
    expect((await runtime(ID.READ, 'other')).json().error.code).toBe('ENROLLMENT_NOT_ACTIVE');
    expect((await outline('other', otherEnrollment)).json().enrollment).toMatchObject({ status: 'suspended', canLearn: false });
  });
});

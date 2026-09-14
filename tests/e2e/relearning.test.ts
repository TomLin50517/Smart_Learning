/**
 * 重新開啟與重修（SA UC-ENR-007／009、§7.2、INV-6、AC-LRN-004、SD §6.25）。
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
const SECRET = 'relearn-e2e-secret-relearn-e2e-secret';
const FINGERPRINT = 'sha256:e2e-relearn';
const ORG = 'abab1212-0000-0000-0000-00000000000a';
const U = {
  admin: 'abab3434-0000-0000-0000-00000000000a',
  instr: 'abab3434-0000-0000-0000-0000000000c1',
  me: 'abab3434-0000-0000-0000-0000000000d1',
  other: 'abab3434-0000-0000-0000-0000000000d2',
};
type Who = keyof typeof U;
const ID = { M1: randomUUID(), M2: randomUUID(), L1: randomUUID(), L2: randomUUID(), READ: randomUUID(), QUIZ: randomUUID(), READ2: randomUUID() };
const QUIZ_CONFIG = { questions: [{ id: 'q1', prompt: '1+1=?', options: [{ id: 'a', label: '1' }, { id: 'b', label: '2' }] }] };
const QUIZ_KEY = { correct: { q1: ['b'] }, pass_threshold: 100 };
const RIGHT = { input: { answers: { q1: ['b'] } } };
const WRONG = { input: { answers: { q1: ['a'] } } };

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let app: NestFastifyApplication;
const s = {} as Record<Who, { token: string; csrf: string }>;
let courseId = '';
let mine = '';
let others = '';

async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const r = await admin.query<{ id: string }>(
    `INSERT INTO user_sessions (user_id, session_token_hash, active_organization_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour') RETURNING id`,
    [userId, hashToken(token), ORG],
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
const start = (activity: string, who: Who = 'me') => call('POST', `/api/activities/${activity}/attempts`, who);
const submit = (attempt: string, body: object, who: Who = 'me') => call('POST', `/api/attempts/${attempt}/submit`, who, body);
/** 開始並送出一次作答，回傳送出的結果 */
const attempt = async (activity: string, body: object = { input: {} }, who: Who = 'me') => {
  const a = await start(activity, who);
  expect(a.statusCode).toBe(201);
  return (await submit(a.json().attemptId, body, who)).json();
};
const outline = async (enrollment = mine) => (await call('GET', `/api/enrollments/${enrollment}/outline`, 'me')).json();
const activities = (o: { modules: { lessons: { activities: { id: string }[] }[] }[] }) =>
  Object.fromEntries(o.modules.flatMap((m) => m.lessons.flatMap((l) => l.activities.map((a) => [a.id, a])))) as Record<string, Record<string, unknown>>;
const relearn = (enrollment: string, body: object, who: Who = 'admin') => call('POST', `/api/enrollments/${enrollment}/relearning`, who, body);
const status = async (enrollment: string) => (await admin.query<{ status: string }>(`SELECT status FROM enrollments WHERE id = $1`, [enrollment])).rows[0]!.status;
const issues = (r: { json(): { error?: { details?: unknown; code?: string } } }) => r.json().error?.details;
const lastAudit = async (action: string) =>
  (await admin.query(`SELECT resource_id, before_state, after_state, metadata FROM audit_logs WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1`, [action])).rows[0];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('iac').withUsername('postgres').withPassword('devonly').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await applyMigrations(admin, { rolePasswords: PW });

  await admin.query(`INSERT INTO organizations (id, code, name, storage_prefix) VALUES ($1, 'org-rl', 'Org RL', 'rl')`, [ORG]);
  for (const k of Object.keys(U) as Who[]) await admin.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [U[k], `${k}@rl.test`, k]);
  await admin.query(
    `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'organization'::scope_type, $2::uuid, $2::uuid FROM roles WHERE code = 'org_admin'`,
    [U.admin, ORG],
  );
  for (const k of ['instr', 'me', 'other'] as const) {
    await admin.query(
      `INSERT INTO user_org_roles (user_id, role_id, scope_type, scope_id, organization_id) SELECT $1::uuid, id, 'self'::scope_type, $1::uuid, $2::uuid FROM roles WHERE code = 'learner'`,
      [U[k], ORG],
    );
  }
  // 授權：最多 1 位進行中的學員（用來驗證重新開啟會重新計入）
  const lic = await admin.query<{ id: string }>(
    `INSERT INTO licenses (license_id, customer_id, edition, license_type, issued_at, maintenance_until, hardware_binding, features, limits, raw_payload)
     VALUES ('lic-rl', 'c', 'enterprise', 'perpetual', now(), now() + interval '1 year', $1, '{}', '{"max_active_learners": 1}', 'x') RETURNING id`,
    [FINGERPRINT],
  );
  await admin.query(`INSERT INTO license_activations (license_id, fingerprint, mode) VALUES ($1, $2, 'offline')`, [lic.rows[0]!.id, FINGERPRINT]);
  for (const k of Object.keys(U) as Who[]) s[k] = await session(U[k]);

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

  // 課程：單元一（閱讀、小考——只能作答 1 次）、單元二（閱讀）；完成條件：必修全部完成
  courseId = (await call('POST', '/api/courses', 'admin', { title: '重修測試課' })).json().id;
  await call('POST', `/api/courses/${courseId}/staff`, 'admin', { email: 'instr@rl.test', role: 'instructor' });
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
            activities: [
              { id: ID.READ, title: '閱讀', activityType: 'reading' },
              { id: ID.QUIZ, title: '小考', activityType: 'quiz', maxScore: 10, maxAttempts: 1, config: QUIZ_CONFIG, answerKey: QUIZ_KEY },
            ],
          },
        ],
      },
      { id: ID.M2, title: '單元二', lessons: [{ id: ID.L2, title: '課節二', activities: [{ id: ID.READ2, title: '延伸閱讀', activityType: 'reading' }] }] },
    ],
  });
  expect(patch.statusCode).toBe(200);
  await call('PUT', `/api/course-versions/${v}/completion-rules`, 'instr', { rule: { type: 'required_activities_completed', value: true } });
  expect((await call('POST', `/api/course-versions/${v}/publish`, 'instr')).statusCode).toBe(200);

  // 我先完成課程（完成後不計入授權的學員數），再加入另一位學員（占掉唯一的名額）
  mine = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'me@rl.test' })).json().id;
  await attempt(ID.READ);
  expect((await attempt(ID.QUIZ, RIGHT)).status).toBe('passed');
  expect((await attempt(ID.READ2)).completionChanged).toBe(true);
  others = (await call('POST', `/api/courses/${courseId}/enrollments`, 'admin', { email: 'other@rl.test' })).json().id;
  expect(await status(mine)).toBe('completed');
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await container?.stop();
});

describe('permissions and limits', () => {
  it('instructors can neither reopen nor assign relearning', async () => {
    expect((await call('POST', `/api/enrollments/${mine}/reopen`, 'instr')).statusCode).toBe(403);
    expect((await relearn(mine, { scopeType: 'course', reason: 'x' }, 'instr')).statusCode).toBe(403);
  });

  it('bringing a completed learner back counts against the licence; an active learner does not', async () => {
    expect((await call('POST', `/api/enrollments/${mine}/reopen`, 'admin')).json().error.code).toBe('LICENSE_LIMIT_EXCEEDED');
    expect((await relearn(mine, { scopeType: 'course', reason: 'x' })).json().error.code).toBe('LICENSE_LIMIT_EXCEEDED');
    expect(await status(mine)).toBe('completed');
    const r = await relearn(others, { scopeType: 'activity', scopeId: ID.READ, reason: '先讀一次' });
    expect(r.statusCode).toBe(201);
    expect(r.json().enrollment.status).toBe('active');
  });

  it('the scope must be in the learner’s version; course scope takes no id', async () => {
    expect(issues(await relearn(others, { scopeType: 'activity', scopeId: randomUUID(), reason: 'x' }))).toEqual([{ field: 'scopeId', issue: 'scope_not_in_version' }]);
    expect(issues(await relearn(others, { scopeType: 'course', scopeId: ID.M1, reason: 'x' }))).toEqual([{ field: 'scopeId', issue: 'scope_must_be_empty' }]);
    expect(issues(await relearn(others, { scopeType: 'module', reason: 'x' }))).toEqual([{ field: 'scopeId', issue: 'scope_required' }]);
  });

  it('withdrawn or active-but-not-completed enrolments cannot be reopened; withdrawn cannot relearn', async () => {
    expect(issues(await call('POST', `/api/enrollments/${others}/reopen`, 'admin'))).toEqual([{ issue: 'invalid_transition', params: { from: 'active' } }]);
    expect((await call('POST', `/api/enrollments/${others}/withdraw`, 'admin')).statusCode).toBe(200);
    expect(issues(await relearn(others, { scopeType: 'course', reason: 'x' }))).toEqual([{ issue: 'invalid_transition', params: { from: 'withdrawn' } }]);
  });
});

describe('reopen (UC-ENR-009)', () => {
  it('completed → reopened keeps the results; completing again goes back to completed', async () => {
    const r = await call('POST', `/api/enrollments/${mine}/reopen`, 'admin', { reason: '想再練習' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'reopened', completedAt: null });
    expect((await lastAudit('enrollment.reopened')).metadata).toMatchObject({ reason: '想再練習' });
    const o = await outline();
    expect(o.enrollment).toMatchObject({ status: 'reopened', canLearn: true });
    expect(o.relearning).toBeNull();
    expect(o.progress).toMatchObject({ requiredCompleted: 3, completed: true });
    expect(activities(o)[ID.QUIZ]).toMatchObject({ state: 'completed', inRelearning: false });
    expect((await attempt(ID.READ2)).completionChanged).toBe(true);
    expect(await status(mine)).toBe('completed');
  });
});

describe('relearning (UC-ENR-007, AC-LRN-004)', () => {
  let moduleRelearning = '';
  let resultsBefore = 0;

  it('a module relearning reopens the course; old results stay but no longer count; attempts start over', async () => {
    resultsBefore = (await admin.query(`SELECT count(*)::int AS n FROM learning_results WHERE enrollment_id = $1`, [mine])).rows[0].n;
    const r = await relearn(mine, { scopeType: 'module', scopeId: ID.M1, reason: '小考再加強', dueDate: '2030-01-31T15:59:59Z' });
    expect(r.statusCode).toBe(201);
    moduleRelearning = r.json().relearning.id;
    expect(r.json().relearning).toMatchObject({ scopeType: 'module', scopeId: ID.M1, scopeTitle: '單元一', reason: '小考再加強', newAttemptPolicy: 'reset_counter', assignedByName: 'admin' });
    expect(r.json().enrollment).toMatchObject({ status: 'reopened', dueDate: '2030-01-31T15:59:59.000Z' });
    expect((await lastAudit('enrollment.relearning.assigned')).before_state).toEqual({ status: 'completed' });

    const o = await outline();
    expect(o.relearning).toMatchObject({ id: moduleRelearning, reason: '小考再加強' });
    expect(o.progress).toMatchObject({ requiredCompleted: 1, completed: false });
    const acts = activities(o);
    expect(acts[ID.READ]).toMatchObject({ state: 'available', inRelearning: true, best: null });
    expect(acts[ID.QUIZ]).toMatchObject({ state: 'available', inRelearning: true, attempts: 0, maxAttempts: 1 });
    expect(acts[ID.READ2]).toMatchObject({ state: 'completed', inRelearning: false });
    // 歷史完整保留（INV-6）
    expect((await admin.query(`SELECT count(*)::int AS n FROM learning_results WHERE enrollment_id = $1`, [mine])).rows[0].n).toBe(resultsBefore);
    expect((await admin.query(`SELECT 1 FROM learning_events WHERE enrollment_id = $1 AND event_type = 'course.reopened' AND payload->>'reason' = '小考再加強'`, [mine])).rowCount).toBe(1);
  });

  it('the capped quiz can be taken again once, as a new attempt linked to the relearning', async () => {
    const a = await start(ID.QUIZ);
    expect(a.statusCode).toBe(201);
    expect(a.json().attemptNo).toBe(2); // 前一次作答仍在，編號接續
    const row = (await admin.query(`SELECT relearning_assignment_id FROM learning_attempts WHERE id = $1`, [a.json().attemptId])).rows[0];
    expect(row.relearning_assignment_id).toBe(moduleRelearning);
    expect((await submit(a.json().attemptId, WRONG)).json().status).toBe('failed');
    expect(issues(await start(ID.QUIZ))).toEqual([{ issue: 'max_attempts_reached' }]);
    // 教師看到的是重修之後的結果；舊的通過紀錄仍可查
    const staff = (await call('GET', `/api/enrollments/${mine}/progress`, 'admin')).json();
    expect(activities(staff)[ID.QUIZ]).toMatchObject({ best: { status: 'failed', score: 0, maxScore: 10 } });
    expect(staff.relearnings).toHaveLength(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM learning_results WHERE enrollment_id = $1 AND activity_id = $2 AND status = 'passed'`, [mine, ID.QUIZ])).rows[0].n).toBe(1);
  });

  it('"append" keeps the used attempts; "reset_counter" gives a fresh one; finishing the scope completes the course', async () => {
    const append = await relearn(mine, { scopeType: 'activity', scopeId: ID.QUIZ, reason: '沿用次數', newAttemptPolicy: 'append' });
    expect(append.json().enrollment.status).toBe('reopened');
    expect(issues(await start(ID.QUIZ))).toEqual([{ issue: 'max_attempts_reached' }]);

    await relearn(mine, { scopeType: 'activity', scopeId: ID.QUIZ, reason: '再給一次機會' });
    const o = await outline();
    expect(o.relearning).toMatchObject({ scopeType: 'activity', scopeTitle: '小考' });
    expect(activities(o)[ID.QUIZ]).toMatchObject({ attempts: 0, inRelearning: true });
    expect((await attempt(ID.QUIZ, RIGHT)).status).toBe('passed');
    expect(activities(await outline())[ID.READ]).toMatchObject({ inRelearning: true }); // 單元重修仍涵蓋閱讀
    const done = await attempt(ID.READ);
    expect(done.completionChanged).toBe(true);
    expect(await status(mine)).toBe('completed');
    expect((await outline()).relearning).toBeNull();
    expect((await call('GET', `/api/enrollments/${mine}/progress`, 'admin')).json().relearnings.map((r: { reason: string }) => r.reason)).toEqual([
      '再給一次機會',
      '沿用次數',
      '小考再加強',
    ]);
  });
});
